package codexgateway

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// 审计阶段 1 W4：事实直读的寿命与停机回执。

// 控制面恢复备份换掉 kin.db 后，读取器按设备号与 inode 发现并重开连接，读到新库的事实（旧连接会一直读已删除的旧文件）。
func TestFactsReaderReopensAReplacedDatabaseFile(t *testing.T) {
	fixture, keyFile := loadFactsFixture(t)
	writer, path := openFactsTestDB(t)
	seedFacts(t, writer, fixture)
	reader, err := OpenFactsReader(path, keyFile, fixture.DBSecret)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	ctx := context.Background()
	if err := reader.Refresh(ctx, true); err != nil {
		t.Fatal(err)
	}
	if _, err := reader.writer(); err != nil {
		t.Fatal(err)
	}
	// 备份库：同样的结构，max_concurrency 改为 9；切换为回滚日志模式后整体替换原文件（恢复备份的做法）
	backup, backupPath := openFactsTestDB(t)
	seedFacts(t, backup, fixture)
	if _, err := backup.Exec("UPDATE vendor_resources SET config_json=json_set(config_json,'$.max_concurrency',9) WHERE id='gw-01'"); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{"PRAGMA wal_checkpoint(TRUNCATE)", "PRAGMA journal_mode=DELETE"} {
		if _, err := backup.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	_ = backup.Close()
	if _, err := writer.Exec("PRAGMA wal_checkpoint(TRUNCATE)"); err != nil {
		t.Fatal(err)
	}
	_ = writer.Close()
	for _, suffix := range []string{"-wal", "-shm"} {
		_ = os.Remove(path + suffix)
	}
	if err := os.Rename(backupPath, path); err != nil {
		t.Fatal(err)
	}
	if err := reader.Refresh(ctx, false); err != nil {
		t.Fatal(err)
	}
	facts, _ := reader.Snapshot()
	if facts["gw-01"].MaxConcurrency != 9 {
		t.Fatalf("facts after the database was replaced = %+v", facts["gw-01"])
	}
	reader.writeMu.Lock()
	writerClosed := reader.writeDB == nil
	reader.writeMu.Unlock()
	if !writerClosed {
		t.Fatal("the write connection to the replaced file must be closed")
	}
	// 写连接按新文件重开
	db, err := reader.writer()
	if err != nil {
		t.Fatal(err)
	}
	var concurrency int
	if err := db.QueryRow("SELECT json_extract(config_json,'$.max_concurrency') FROM vendor_resources WHERE id='gw-01'").Scan(&concurrency); err != nil || concurrency != 9 {
		t.Fatalf("writer reads %d err=%v", concurrency, err)
	}
}

// 事实超过 2 分钟没有读成功：拒绝调度（503 gateway_facts_stale，未发送），健康与心跳报告陈旧时长。
func TestStaleFactsRefuseScheduling(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		nativeReply("native")(w)
	}))
	t.Cleanup(upstream.Close)
	server, httpServer, cfg := newExecuteServer(t, upstream.URL, Account{ID: "acct_1", Enabled: true, AccessToken: "token", Groups: []string{"1"}})
	fixture, keyFile := loadFactsFixture(t)
	_, path := openFactsTestDB(t)
	reader, err := OpenFactsReader(path, keyFile, fixture.DBSecret)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reader.Close() })
	server.facts = &factsState{reader: reader}
	envelope := func(n string) Envelope {
		return Envelope{Dispatch: "dispatch_" + n, RequestID: "request_" + n, Nonce: n, Operation: "responses", Protocol: "openai.responses", Model: "gpt-test", Stream: true, Body: json.RawMessage(`{"model":"gpt-test","stream":true}`), Scope: Scope{GroupIDs: []int64{1}}}
	}
	reader.mu.Lock()
	reader.okAt = time.Now().Add(-factsStaleAfter - time.Second)
	reader.mu.Unlock()
	response := signedExecute(t, cfg, httpServer.URL, envelope("stale"))
	data, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusServiceUnavailable || !strings.Contains(string(data), "gateway_facts_stale") || response.Header.Get(sendStateHeader) != sendStateNotSent {
		t.Fatalf("stale facts: status=%d send=%q body=%s", response.StatusCode, response.Header.Get(sendStateHeader), data)
	}
	recorder := httptest.NewRecorder()
	server.health(recorder, httptest.NewRequest(http.MethodGet, "/internal/v1/health", nil))
	var health struct {
		HealthState string `json:"health_state"`
		Facts       struct {
			Status FactsStatus `json:"status"`
		} `json:"facts"`
	}
	_ = json.Unmarshal(recorder.Body.Bytes(), &health)
	if health.HealthState != "degraded" || !health.Facts.Status.Stale || health.Facts.Status.StaleSeconds < int64(factsStaleAfter/time.Second) {
		t.Fatalf("health = %s", recorder.Body.String())
	}
	// 读取恢复后照常调度
	if err := reader.Refresh(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	response = signedExecute(t, cfg, httpServer.URL, envelope("fresh"))
	data, _ = io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusOK || !strings.Contains(string(data), "native") {
		t.Fatalf("fresh facts: status=%d body=%s", response.StatusCode, data)
	}
}

// 收到退出信号时仍在途的流：按停机取消，回执记 worker_shutdown 与已交付部分的用量（partial），在关闭事件日志前写出。
func TestShutdownWritesReceiptsForInFlightStreams(t *testing.T) {
	previous := shutdownCancelAfter
	shutdownCancelAfter = 100 * time.Millisecond
	t.Cleanup(func() { shutdownCancelAfter = previous })
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"type\":\"response.created\",\"response\":{\"id\":\"r1\"}}\n\n"+
			"data: {\"type\":\"response.in_progress\",\"response\":{\"id\":\"r1\",\"usage\":{\"input_tokens\":5,\"output_tokens\":2}}}\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	t.Cleanup(upstream.Close)
	server, httpServer, cfg := newExecuteServer(t, upstream.URL, Account{ID: "acct_1", Enabled: true, AccessToken: "token", Groups: []string{"1"}})
	done := make(chan *http.Response, 1)
	go func() {
		done <- signedExecute(t, cfg, httpServer.URL, Envelope{Dispatch: "dispatch_shutdown", RequestID: "request_shutdown", Nonce: "shutdown", Operation: "responses", Protocol: "openai.responses", Model: "gpt-test", Stream: true, Body: json.RawMessage(`{"model":"gpt-test","stream":true}`), Scope: Scope{GroupIDs: []int64{1}}})
	}()
	deadline := time.Now().Add(3 * time.Second)
	for atomic.LoadInt64(&server.active) == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(100 * time.Millisecond)
	finished := make(chan struct{})
	go func() {
		server.shutdownHTTP(httpServer.Config)
		close(finished)
	}()
	select {
	case response := <-done:
		_, _ = io.Copy(io.Discard, response.Body)
		response.Body.Close()
	case <-time.After(3 * time.Second):
		t.Fatal("shutdown did not cancel the in-flight stream")
	}
	select {
	case <-finished:
	case <-time.After(shutdownGrace):
		t.Fatal("shutdown did not finish")
	}
	receipt := awaitFinalizedReceipt(t, cfg.DataDir, func(r map[string]any) bool { return r["dispatch_id"] == "dispatch_shutdown" })
	usage, _ := receipt["usage"].(map[string]any)
	if receipt["terminal_state"] != terminalCancelled || receipt["error_code"] != drainReasonShutdown || receipt["usage_confidence"] != "partial" || usage["input_tokens"] != float64(5) {
		t.Fatalf("receipt=%v", receipt)
	}
}

func nativeReply(text string) func(http.ResponseWriter) {
	return sseReply(`{"type":"response.created","response":{"id":"r_native"}}`, `{"type":"response.output_text.delta","delta":"`+text+`"}`, `{"type":"response.completed","response":{"id":"r_native","usage":{"input_tokens":1,"output_tokens":1}}}`)
}
