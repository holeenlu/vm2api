package codexgateway

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"net/url"
	"time"
)

// dbStamp：kin.db 的时间戳存储形式，与控制面 src/shared/system-time.mjs 的 dbTime 一致，
// 固定 UTC+8 偏移、固定宽度（毫秒），字符串序等于时间序。
func dbStamp(t time.Time) string {
	return t.In(systemZone).Format("2006-01-02T15:04:05.000-07:00")
}

// 刷新后的凭据写回（2026-11-07 S1b，对齐 CPR / sub2api：刷新者直接按代次 CAS 写库）。
//
// Worker 刷新原生授权后，把新令牌按 vault.mjs 的格式加密写进控制面凭据库 executor_credentials，
// 不再经刷新租约与 HTTP 轮换报告。正确性靠代次 CAS：本地凭据记着它来自凭据库的哪个代次（Account.CredentialBase）；
// 库里仍是这个代次（或记录已丢失）才写入，否则期间控制面重新授权或导入过，这次刷新作废，事实合并时换入库里的凭据
// （facts_apply.go）。
// 写库失败时新令牌已在本地账号表落盘，后台循环重试（syncCredentials），重启后同样补写。
// 互斥：同一账号的刷新在进程内按账号单飞（refreshNow），只支持同机单个 Worker（设计第 19 节）。

var errCredentialSuperseded = errors.New("the vault was changed by the control plane; this refresh is discarded")

// writer 是凭据写回用的读写连接（与只读的读取连接分开；短事务、busy_timeout，不挡住控制面的写入太久）。
func (r *FactsReader) writer() (*sql.DB, error) {
	r.writeMu.Lock()
	defer r.writeMu.Unlock()
	if r.writeDB != nil {
		return r.writeDB, nil
	}
	dsn := "file:" + (&url.URL{Path: r.path}).EscapedPath() + "?_pragma=busy_timeout(5000)&_txlock=immediate"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	r.writeDB = db
	return db, nil
}

// credentialWrite 是一次原生凭据写回：base 为本地凭据来自的库内代次。
type credentialWrite struct {
	Resource   string
	Revision   int64
	Base       int64
	Secrets    vaultSecrets
	ExpiresAt  time.Time
	InstanceID string
}

// writeCredential 在一个短事务里按代次 CAS 写入；期间库被控制面改过时返回 errCredentialSuperseded。
func (r *FactsReader) writeCredential(ctx context.Context, w credentialWrite) error {
	masterID, wrapped, ciphertext, err := sealVaultRecord(r.keyring, w.Resource, refreshGrantNative, w.Revision, w.Secrets)
	if err != nil {
		return err
	}
	db, err := r.writer()
	if err != nil {
		return err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	var current sql.NullInt64
	var currentFingerprint sql.NullString
	if err := tx.QueryRowContext(ctx, "SELECT revision, token_fingerprint FROM executor_credentials WHERE account_resource_id=? AND grant_kind=?", w.Resource, refreshGrantNative).Scan(&current, &currentFingerprint); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	// 同一次写回的重试：库里已是这个代次、这份令牌
	if current.Valid && current.Int64 == w.Revision && currentFingerprint.String == tokenFingerprint(w.Secrets.RefreshToken) {
		return nil
	}
	// 库里不是本地凭据来自的代次（记录丢失除外）：控制面期间重新授权或导入过。
	// 来源代次未知（升级前的本地账号，Base 为 0）时只要求新代次更高
	if current.Valid && ((w.Base != 0 && current.Int64 != w.Base) || current.Int64 >= w.Revision) {
		return errCredentialSuperseded
	}
	var expires any
	if !w.ExpiresAt.IsZero() {
		expires = dbStamp(w.ExpiresAt)
	}
	now := dbStamp(time.Now())
	if _, err := tx.ExecContext(ctx, `INSERT INTO executor_credentials(account_resource_id,grant_kind,revision,master_key_id,wrapped_key,ciphertext,token_fingerprint,expires_at,source,source_instance_id,updated_at)
		VALUES(?,?,?,?,?,?,?,?,'refresh',?,?)
		ON CONFLICT(account_resource_id,grant_kind) DO UPDATE SET revision=excluded.revision,master_key_id=excluded.master_key_id,
		  wrapped_key=excluded.wrapped_key,ciphertext=excluded.ciphertext,token_fingerprint=excluded.token_fingerprint,
		  expires_at=excluded.expires_at,source=excluded.source,source_instance_id=excluded.source_instance_id,updated_at=excluded.updated_at`,
		w.Resource, refreshGrantNative, w.Revision, masterID, wrapped, ciphertext, nullableString(tokenFingerprint(w.Secrets.RefreshToken)), expires, nullableString(w.InstanceID), now); err != nil {
		return err
	}
	return tx.Commit()
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

// syncCredentials 把本地比凭据库新的凭据写回库（刷新成功后立即调用；后台循环兜底重试）。only 非空时只处理该运行账号。
func (s *Server) syncCredentials(ctx context.Context, only string) {
	if s.facts == nil {
		return
	}
	facts, _ := s.facts.reader.Snapshot()
	for _, fact := range facts {
		if fact.Deleted || fact.RuntimeID == "" || (only != "" && fact.RuntimeID != only) || len(fact.Errors) > 0 {
			continue
		}
		account, ok := s.store.Get(fact.RuntimeID)
		if !ok {
			continue
		}
		vaultNative := int64(0)
		if fact.Native != nil {
			vaultNative = fact.Native.Revision
		}
		if account.CredentialRevision > vaultNative && (account.RefreshToken != "" || account.AccessToken != "") {
			err := s.facts.reader.writeCredential(ctx, credentialWrite{
				Resource: fact.ResourceID, Revision: account.CredentialRevision, Base: account.CredentialBase,
				Secrets:   vaultSecrets{AccessToken: account.AccessToken, RefreshToken: account.RefreshToken, IDToken: account.IDToken, APIKey: account.APIKey},
				ExpiresAt: account.ExpiresAt, InstanceID: s.cfg.InstanceID,
			})
			s.recordCredentialWrite(account.ID, account.CredentialRevision, err)
		}
	}
}

// recordCredentialWrite：原生写入成功后本地凭据的来源代次前进到写入的代次；失败只记日志（后台循环重试）。
func (s *Server) recordCredentialWrite(accountID string, revision int64, err error) {
	switch {
	case err == nil:
		s.store.SetCredentialBase(accountID, revision)
	case errors.Is(err, errCredentialSuperseded):
		log.Printf("codex-gateway: %s credentials of %s were replaced by the control plane; dropping refresh revision %d", refreshGrantNative, accountID, revision)
	default:
		log.Printf("codex-gateway: writing %s credentials of %s (revision %d) to the vault failed; retrying later: %v", refreshGrantNative, accountID, revision, err)
	}
}

// credentialSyncLoop 定期补写未能写回的凭据（写库失败、进程重启）。
func (s *Server) credentialSyncLoop(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			syncCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
			s.syncCredentials(syncCtx, "")
			cancel()
		}
	}
}
