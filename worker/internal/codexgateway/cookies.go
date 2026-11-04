package codexgateway

import (
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// 账号级 Codex Cookie（对齐 codex-proxy-rs credential/cookie.rs）：只接收官方允许名单内、
// 作用域属于 chatgpt.com / openai.com 的 Set-Cookie，按账号与凭据代次保存；
// 之后同账号的模型与账号请求按域名、路径与 Secure 规则回放。凭据代次变化即失效，API Key 账号不使用。
var (
	codexCookieNames   = []string{"__Secure-next-auth.session-token", "__Secure-authjs.session-token", "oai-did", "cf_clearance", "__cf_bm", "_cfuvid"}
	codexCookieDomains = []string{"chatgpt.com", "openai.com"}
)

const (
	maxSetCookieHeaders     = 32
	maxSetCookieHeaderBytes = 16 << 10
	maxSetCookieTotalBytes  = 64 << 10
	maxCookieHeaderBytes    = 16 << 10
	maxStoredCookies        = 64
)

// StoredCookie 只在 Worker 账号文件中保存，对外视图会清除。
type StoredCookie struct {
	Name      string    `json:"name"`
	Value     string    `json:"value"`
	Domain    string    `json:"domain"`
	HostOnly  bool      `json:"host_only,omitempty"`
	Path      string    `json:"path"`
	Secure    bool      `json:"secure,omitempty"`
	ExpiresAt time.Time `json:"expires_at,omitempty"`
}

type cookieUpdate struct {
	cookie StoredCookie
	delete bool
}

func normalizeCookieDomain(domain string) (string, bool) {
	domain = strings.ToLower(strings.Trim(strings.TrimSpace(domain), "."))
	if domain == "" || len(domain) > 253 || strings.ContainsAny(domain, "/:") {
		return "", false
	}
	for _, label := range strings.Split(domain, ".") {
		if label == "" || len(label) > 63 || strings.HasPrefix(label, "-") || strings.HasSuffix(label, "-") {
			return "", false
		}
		for _, c := range label {
			if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
				return "", false
			}
		}
	}
	return domain, true
}

func cookieDomainMatches(host, domain string) bool {
	return host == domain || strings.HasSuffix(host, "."+domain)
}

func allowedCookieDomain(domain string) bool {
	for _, allowed := range codexCookieDomains {
		if cookieDomainMatches(domain, allowed) {
			return true
		}
	}
	return false
}

func cookiePathMatches(requestPath, cookiePath string) bool {
	if requestPath == cookiePath {
		return true
	}
	if !strings.HasPrefix(requestPath, cookiePath) {
		return false
	}
	return strings.HasSuffix(cookiePath, "/") || strings.HasPrefix(requestPath[len(cookiePath):], "/")
}

func defaultCookiePath(requestPath string) string {
	if !strings.HasPrefix(requestPath, "/") || requestPath == "/" {
		return "/"
	}
	last := strings.LastIndex(requestPath, "/")
	if last <= 0 {
		return "/"
	}
	return requestPath[:last]
}

// parseCodexSetCookies 校验一批响应 Set-Cookie；超出数量或总长时整批丢弃。
func parseCodexSetCookies(origin *url.URL, headers []string, now time.Time) []cookieUpdate {
	if origin == nil || len(headers) == 0 || len(headers) > maxSetCookieHeaders {
		return nil
	}
	total := 0
	for _, header := range headers {
		total += len(header)
	}
	if total > maxSetCookieTotalBytes {
		return nil
	}
	if origin.Scheme != "https" && origin.Scheme != "http" {
		return nil
	}
	host, ok := normalizeCookieDomain(origin.Hostname())
	if !ok || !allowedCookieDomain(host) {
		return nil
	}
	var out []cookieUpdate
	for _, header := range headers {
		if header == "" || len(header) > maxSetCookieHeaderBytes {
			continue
		}
		parsed, err := http.ParseSetCookie(header)
		if err != nil || !containsString(codexCookieNames, parsed.Name) {
			continue
		}
		path := parsed.Path
		if path == "" {
			path = defaultCookiePath(origin.Path)
		}
		if len(path) > 1024 || !strings.HasPrefix(path, "/") {
			continue
		}
		cookie := StoredCookie{Name: parsed.Name, Value: parsed.Value, Path: path, Secure: parsed.Secure, Domain: host, HostOnly: true}
		if parsed.Domain != "" {
			domain, ok := normalizeCookieDomain(parsed.Domain)
			if !ok || !allowedCookieDomain(domain) || !cookieDomainMatches(host, domain) {
				continue
			}
			cookie.Domain, cookie.HostOnly = domain, false
		}
		switch {
		case parsed.MaxAge > 0:
			cookie.ExpiresAt = now.Add(time.Duration(parsed.MaxAge) * time.Second)
		case parsed.MaxAge < 0:
			cookie.ExpiresAt = now
		case !parsed.Expires.IsZero():
			cookie.ExpiresAt = parsed.Expires
		}
		remove := !cookie.ExpiresAt.IsZero() && !cookie.ExpiresAt.After(now)
		if cookie.Value == "" && !remove {
			continue
		}
		out = append(out, cookieUpdate{cookie: cookie, delete: remove})
	}
	return out
}

func (c StoredCookie) mayReplay(target *url.URL, now time.Time) bool {
	if !c.ExpiresAt.IsZero() && !c.ExpiresAt.After(now) {
		return false
	}
	host, ok := normalizeCookieDomain(target.Hostname())
	if !ok || !allowedCookieDomain(host) || (c.Secure && target.Scheme != "https" && target.Scheme != "wss") {
		return false
	}
	path := target.Path
	if path == "" {
		path = "/"
	}
	if !cookiePathMatches(path, c.Path) {
		return false
	}
	if c.HostOnly {
		return host == c.Domain
	}
	return cookieDomainMatches(host, c.Domain)
}

// ApplyCookies 按（名称, 域名, 路径）合并更新；凭据代次已变化的迟到响应不写入。
func (s *Store) ApplyCookies(id string, revision int64, updates []cookieUpdate, now time.Time) {
	if len(updates) == 0 {
		return
	}
	s.mu.Lock()
	account, ok := s.accounts[id]
	if !ok || account.APIKey != "" || account.CredentialRevision != revision {
		s.mu.Unlock()
		return
	}
	cookies := make([]StoredCookie, 0, len(account.Cookies)+len(updates))
	for _, cookie := range account.Cookies {
		if cookie.ExpiresAt.IsZero() || cookie.ExpiresAt.After(now) {
			cookies = append(cookies, cookie)
		}
	}
	changed := len(cookies) != len(account.Cookies)
	for _, update := range updates {
		index := -1
		for i, existing := range cookies {
			if existing.Name == update.cookie.Name && existing.Domain == update.cookie.Domain && existing.Path == update.cookie.Path {
				index = i
				break
			}
		}
		switch {
		case update.delete && index >= 0:
			cookies = append(cookies[:index], cookies[index+1:]...)
			changed = true
		case update.delete:
		case index >= 0:
			if cookies[index] != update.cookie {
				cookies[index] = update.cookie
				changed = true
			}
		default:
			cookies = append(cookies, update.cookie)
			changed = true
		}
	}
	if len(cookies) > maxStoredCookies {
		cookies = cookies[len(cookies)-maxStoredCookies:]
	}
	if !changed {
		s.mu.Unlock()
		return
	}
	account.Cookies = cookies
	s.accounts[id] = account
	s.mu.Unlock()
	s.persistSoon()
}

// cookieHeader 生成回放到 target 的 Cookie 头（路径更长者在前），超长时不回放。
func cookieHeader(cookies []StoredCookie, target *url.URL, now time.Time) string {
	var matched []StoredCookie
	for _, cookie := range cookies {
		if cookie.mayReplay(target, now) && !strings.ContainsAny(cookie.Value, ";\r\n") {
			matched = append(matched, cookie)
		}
	}
	sort.SliceStable(matched, func(i, j int) bool { return len(matched[i].Path) > len(matched[j].Path) })
	parts := make([]string, 0, len(matched))
	for _, cookie := range matched {
		parts = append(parts, cookie.Name+"="+cookie.Value)
	}
	header := strings.Join(parts, "; ")
	if len(header) > maxCookieHeaderBytes {
		return ""
	}
	return header
}

// mergeCookieHeader 把账号 Cookie 合入已有 Cookie 头；同名以账号保存值为准。
func mergeCookieHeader(header http.Header, stored string) {
	if stored == "" {
		return
	}
	names := map[string]bool{}
	for _, part := range strings.Split(stored, "; ") {
		name, _, _ := strings.Cut(part, "=")
		names[name] = true
	}
	parts := []string{}
	for _, value := range header.Values("Cookie") {
		for _, part := range strings.Split(value, ";") {
			part = strings.TrimSpace(part)
			name, _, _ := strings.Cut(part, "=")
			if part != "" && !names[strings.TrimSpace(name)] {
				parts = append(parts, part)
			}
		}
	}
	header.Set("Cookie", strings.Join(append(parts, stored), "; "))
}

// accountCookieTransport 为 OAuth 账号的请求回放并采集 Cookie；连接池仍由底层 Transport 按代理共享。
type accountCookieTransport struct {
	base     http.RoundTripper
	store    *Store
	account  string
	revision int64
}

func (t *accountCookieTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if account, ok := t.store.Get(t.account); ok && account.CredentialRevision == t.revision {
		if stored := cookieHeader(account.Cookies, req.URL, time.Now()); stored != "" {
			req = req.Clone(req.Context())
			mergeCookieHeader(req.Header, stored)
		}
	}
	resp, err := t.base.RoundTrip(req)
	if err == nil {
		t.store.ApplyCookies(t.account, t.revision, parseCodexSetCookies(req.URL, resp.Header.Values("Set-Cookie"), time.Now()), time.Now())
	}
	return resp, err
}
