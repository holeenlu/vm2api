package codexgateway

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// 上游客户端画像（对齐 codex-proxy-rs transport/profile）：控制面保存通用选择与 Key 覆盖，Worker 按官方
// 发布资料解析为请求身份（User-Agent、originator、version、residency、账号路由覆盖）。
//   - 预设：client desktop|cli × platform macos|linux|windows，versionMode latest（可滞后 1～10 个已观察
//     版本）或 fixed；CLI 可选入口 tui/exec。
//   - 自定义：{mode:"custom", userAgent, originator?, codexVersion?}，识别官方前缀时自动解析配套头。
//
// 首次默认 macOS · Desktop · 自动最新；每 24 小时检查官方稳定发布，失败保留同组合上次有效版本。
const (
	maxVersionLag          = 10
	releaseHistoryCapacity = maxVersionLag + 1
)

var errProfileInvalid = errors.New("client profile selection is invalid")
var errProfileReleaseUnavailable = errors.New("official release for this client profile is unavailable")

// ClientProfileSelection 是控制面下发的选择（预设或自定义）。
type ClientProfileSelection struct {
	Mode           string `json:"mode,omitempty"`
	Client         string `json:"client,omitempty"`
	Platform       string `json:"platform,omitempty"`
	VersionMode    string `json:"versionMode,omitempty"`
	VersionLag     int    `json:"versionLag,omitempty"`
	CliEntry       string `json:"cliEntry,omitempty"`
	Originator     string `json:"originator,omitempty"`
	OsType         string `json:"osType,omitempty"`
	OsVersion      string `json:"osVersion,omitempty"`
	Arch           string `json:"arch,omitempty"`
	Terminal       string `json:"terminal,omitempty"`
	CodexVersion   string `json:"codexVersion,omitempty"`
	DesktopVersion string `json:"desktopVersion,omitempty"`
	DesktopBuild   string `json:"desktopBuild,omitempty"`
	UserAgent      string `json:"userAgent,omitempty"`
}

// ProfileDeployment 是部署级配套头，不随客户端选择变化；未配置时不发送。
type ProfileDeployment struct {
	Residency              string `json:"residency,omitempty"`
	AccountRoutingOverride string `json:"accountRoutingOverride,omitempty"`
}

func defaultProfileSelection() ClientProfileSelection {
	return ClientProfileSelection{Client: "desktop", Platform: "macos", VersionMode: "latest"}
}

// wireProfile 是一次请求冻结的身份快照。
type wireProfile struct {
	Client         string    `json:"client"`
	Originator     string    `json:"originator"`
	CodexVersion   string    `json:"codexVersion"`
	DesktopVersion string    `json:"desktopVersion,omitempty"`
	DesktopBuild   string    `json:"desktopBuild,omitempty"`
	OsType         string    `json:"osType"`
	OsVersion      string    `json:"osVersion"`
	Arch           string    `json:"arch"`
	Terminal       string    `json:"terminal"`
	ExactUserAgent string    `json:"-"`
	Residency      string    `json:"-"`
	RoutingOverr   string    `json:"-"`
	VerifiedAt     time.Time `json:"-"`
}

// userAgent：自定义保留完整 UA；CLI 为 `o/v (os ver; arch) term`，Desktop 追加 `(o; desktopVersion)`。
func (p wireProfile) userAgent() string {
	if p.ExactUserAgent != "" {
		return p.ExactUserAgent
	}
	base := fmt.Sprintf("%s/%s (%s %s; %s) %s", p.Originator, p.CodexVersion, p.OsType, p.OsVersion, p.Arch, p.Terminal)
	if p.Client == "cli" {
		return base
	}
	return fmt.Sprintf("%s (%s; %s)", base, p.Originator, p.DesktopVersion)
}

// desktopUserAgent 是 Desktop 下载类请求（官方头像）的 UA：`originator/desktopVersion (os; arch)`，与 CPR 相同。
func (p wireProfile) desktopUserAgent() string {
	return fmt.Sprintf("%s/%s (%s; %s)", p.Originator, p.DesktopVersion, p.OsType, p.Arch)
}

func platformOSType(platform string) string {
	switch platform {
	case "linux":
		return "Linux"
	case "windows":
		return "Windows"
	}
	return "Mac OS"
}

func platformOSVersion(platform string) string {
	switch platform {
	case "linux":
		return "6.8.0"
	case "windows":
		return "10.0.26100"
	}
	return "15.7.1"
}

func platformArch(platform string) string {
	if platform == "macos" {
		return "arm64"
	}
	return "x86_64"
}

func (s ClientProfileSelection) architecture() string {
	if s.Arch != "" {
		return s.Arch
	}
	return platformArch(s.Platform)
}

func safeProfileField(value string, max int) bool {
	if value == "" || len(value) > max || strings.TrimSpace(value) != value {
		return false
	}
	for _, c := range []byte(value) {
		if c < 32 || c > 126 {
			return false
		}
	}
	return true
}

// validSemver 校验 SemVer 2.0（不引入依赖）：主版本.次版本.修订号，可选预发布与构建元数据。
func validSemver(value string) bool {
	if value == "" || len(value) > 64 {
		return false
	}
	core, build, hasBuild := strings.Cut(value, "+")
	if hasBuild && !validIdentifiers(build, false) {
		return false
	}
	core, pre, hasPre := strings.Cut(core, "-")
	if hasPre && !validIdentifiers(pre, true) {
		return false
	}
	parts := strings.Split(core, ".")
	if len(parts) != 3 {
		return false
	}
	for _, part := range parts {
		if !numericIdentifier(part) {
			return false
		}
	}
	return true
}

func numericIdentifier(part string) bool {
	if part == "" || (len(part) > 1 && part[0] == '0') {
		return false
	}
	for _, c := range part {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

func validIdentifiers(text string, pre bool) bool {
	for _, part := range strings.Split(text, ".") {
		if part == "" {
			return false
		}
		digits := true
		for _, c := range part {
			if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c == '-') {
				return false
			}
			digits = digits && c >= '0' && c <= '9'
		}
		if pre && digits && len(part) > 1 && part[0] == '0' {
			return false
		}
	}
	return true
}

func numericDottedVersion(value string) bool {
	parts := strings.Split(value, ".")
	if len(parts) < 2 {
		return false
	}
	for _, part := range parts {
		if part == "" {
			return false
		}
		for _, c := range part {
			if c < '0' || c > '9' {
				return false
			}
		}
	}
	return true
}

func (s ClientProfileSelection) validate() error {
	if s.Mode == "custom" {
		_, err := parseCustomIdentity(s)
		return err
	}
	if s.Mode != "" || (s.Client != "desktop" && s.Client != "cli") || (s.Platform != "macos" && s.Platform != "linux" && s.Platform != "windows") {
		return errProfileInvalid
	}
	if s.Client == "desktop" && s.CliEntry != "" {
		return errProfileInvalid
	}
	if s.CliEntry != "" && s.CliEntry != "tui" && s.CliEntry != "exec" {
		return errProfileInvalid
	}
	for _, value := range []string{s.Originator, s.OsType, s.OsVersion, s.Arch, s.Terminal} {
		if value != "" && (!safeProfileField(value, 128) || strings.ContainsAny(value, "();\\")) {
			return errProfileInvalid
		}
	}
	switch s.VersionMode {
	case "latest":
		if s.CodexVersion != "" || s.DesktopVersion != "" || s.DesktopBuild != "" || s.VersionLag < 0 || s.VersionLag > maxVersionLag {
			return errProfileInvalid
		}
	case "fixed":
		if s.VersionLag != 0 || !validSemver(s.CodexVersion) {
			return errProfileInvalid
		}
		if s.Client == "desktop" {
			if len(s.DesktopVersion) > 64 || !numericDottedVersion(s.DesktopVersion) || s.DesktopBuild == "" || len(s.DesktopBuild) > 32 {
				return errProfileInvalid
			}
			if _, err := strconv.ParseUint(s.DesktopBuild, 10, 64); err != nil {
				return errProfileInvalid
			}
		}
	default:
		return errProfileInvalid
	}
	if s.Client == "cli" && (s.DesktopVersion != "" || s.DesktopBuild != "") {
		return errProfileInvalid
	}
	return nil
}

var knownOriginators = []string{"Codex Desktop", "codex-tui", "codex_exec", "codex_cli_rs"}

// parseCustomIdentity：识别官方前缀时从 UA 解析 originator 与 Core 版本（显式值必须一致），
// 否则要求另填 originator 与 codexVersion；Desktop UA 末尾的 `(Codex Desktop; x.y)` 给出应用版本。
func parseCustomIdentity(s ClientProfileSelection) (wireProfile, error) {
	ua := s.UserAgent
	if !safeProfileField(ua, 4096) {
		return wireProfile{}, errProfileInvalid
	}
	profile := wireProfile{ExactUserAgent: ua, Client: "cli"}
	var rest string
	recognized := false
	for _, name := range knownOriginators {
		if after, ok := strings.CutPrefix(ua, name+"/"); ok {
			version, _, _ := strings.Cut(after, " ")
			if !validSemver(version) || (s.Originator != "" && s.Originator != name) || (s.CodexVersion != "" && s.CodexVersion != version) {
				return wireProfile{}, errProfileInvalid
			}
			profile.Originator, profile.CodexVersion, rest, recognized = name, version, after, true
			break
		}
	}
	if !recognized {
		if !safeProfileField(s.Originator, 128) || !validSemver(s.CodexVersion) {
			return wireProfile{}, errProfileInvalid
		}
		profile.Originator, profile.CodexVersion = s.Originator, s.CodexVersion
	}
	if profile.Originator == "Codex Desktop" {
		profile.Client = "desktop"
		if index := strings.LastIndex(ua, " (Codex Desktop; "); index >= 0 {
			version := strings.TrimSuffix(ua[index+len(" (Codex Desktop; "):], ")")
			if numericDottedVersion(version) {
				profile.DesktopVersion = version
			}
		}
	}
	if recognized {
		if _, environment, ok := strings.Cut(rest, " ("); ok {
			if inner, tail, ok := strings.Cut(environment, ") "); ok {
				if osPart, arch, ok := strings.Cut(inner, "; "); ok {
					if index := strings.LastIndex(osPart, " "); index > 0 {
						terminal, _, _ := strings.Cut(tail, " (")
						if terminal != "" && arch != "" {
							profile.OsType, profile.OsVersion, profile.Arch, profile.Terminal = osPart[:index], osPart[index+1:], arch, terminal
						}
					}
				}
			}
		}
	}
	return profile, nil
}

// clientRelease 是一个具体客户端制品的配套版本。
type clientRelease struct {
	CodexVersion   string    `json:"codexVersion"`
	DesktopVersion string    `json:"desktopVersion,omitempty"`
	DesktopBuild   string    `json:"desktopBuild,omitempty"`
	VerifiedAt     time.Time `json:"verifiedAt,omitempty"`
	// Identity 是 Windows/Linux 安装包的 size+ETag，未变化时复用已核验版本
	Identity string `json:"identity,omitempty"`
}

func (r clientRelease) sameIdentity(other clientRelease) bool {
	return r.CodexVersion == other.CodexVersion && r.DesktopVersion == other.DesktopVersion && r.DesktopBuild == other.DesktopBuild
}

type releaseSlot struct {
	History   []clientRelease `json:"history"`
	CheckedAt time.Time       `json:"checkedAt,omitempty"`
	Error     string          `json:"error,omitempty"`
}

// releaseStore 按 client|platform|arch 保存观察到的发布序列（新→旧，最多 11 项），持久化到数据目录。
type releaseStore struct {
	mu    sync.RWMutex
	path  string
	slots map[string]*releaseSlot
}

func releaseKey(client, platform, arch string) string { return client + "|" + platform + "|" + arch }

var cliTargets = [][2]string{{"macos", "arm64"}, {"macos", "x86_64"}, {"linux", "arm64"}, {"linux", "x86_64"}, {"windows", "arm64"}, {"windows", "x86_64"}}

func newReleaseStore(path string) *releaseStore {
	store := &releaseStore{path: path, slots: map[string]*releaseSlot{}}
	seeded := time.Date(2026, 9, 18, 0, 0, 0, 0, time.UTC)
	// 离线启动种子（CPR 2026-09 核验的官方资料）；后台检查成功后被更新的已核验版本取代
	for _, target := range cliTargets {
		store.seed("cli", target[0], target[1], clientRelease{CodexVersion: "0.155.0", VerifiedAt: seeded})
	}
	store.seed("desktop", "macos", "arm64", clientRelease{CodexVersion: "0.153.4", DesktopVersion: "26.901.51231", DesktopBuild: "8109", VerifiedAt: time.Date(2026, 9, 6, 3, 26, 12, 0, time.UTC)})
	for _, arch := range []string{"x86_64", "arm64"} {
		store.seed("desktop", "windows", arch, clientRelease{CodexVersion: "0.154.0-alpha.6.2", DesktopVersion: "26.908.70816", DesktopBuild: "9275", VerifiedAt: seeded})
		store.seed("desktop", "linux", arch, clientRelease{CodexVersion: "0.155.0-alpha.9", DesktopVersion: "26.915.31029", DesktopBuild: "9771", VerifiedAt: seeded})
	}
	if data, err := os.ReadFile(path); err == nil {
		var saved map[string]*releaseSlot
		if json.Unmarshal(data, &saved) == nil {
			for key, slot := range saved {
				if slot == nil || len(slot.History) == 0 {
					continue
				}
				if len(slot.History) > releaseHistoryCapacity {
					slot.History = slot.History[:releaseHistoryCapacity]
				}
				store.slots[key] = slot
			}
		}
	}
	return store
}

func (r *releaseStore) seed(client, platform, arch string, release clientRelease) {
	r.slots[releaseKey(client, platform, arch)] = &releaseSlot{History: []clientRelease{release}}
}

// record 记录一次检查结果：成功时把新版本放到序列首位（同一版本只更新核验时间），失败只记录错误。
func (r *releaseStore) record(client, platform, arch string, release *clientRelease, failure error, now time.Time) {
	r.mu.Lock()
	defer r.mu.Unlock()
	key := releaseKey(client, platform, arch)
	slot := r.slots[key]
	if slot == nil {
		slot = &releaseSlot{}
		r.slots[key] = slot
	}
	slot.CheckedAt = now
	if failure != nil {
		slot.Error = failure.Error()
	} else if release != nil {
		slot.Error = ""
		if len(slot.History) > 0 && slot.History[0].sameIdentity(*release) {
			slot.History[0] = *release
		} else {
			slot.History = append([]clientRelease{*release}, slot.History...)
		}
		if len(slot.History) > releaseHistoryCapacity {
			slot.History = slot.History[:releaseHistoryCapacity]
		}
	}
	if data, err := json.Marshal(r.slots); err == nil && r.path != "" {
		_ = writeFileAtomic(r.path, data)
	}
}

func (r *releaseStore) latest(client, platform, arch string) (clientRelease, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	slot := r.slots[releaseKey(client, platform, arch)]
	if slot == nil || len(slot.History) == 0 {
		return clientRelease{}, false
	}
	return slot.History[0], true
}

// lagged 取已观察序列的第 lag 项，序列不足时回退最旧已核验版本。
func (r *releaseStore) lagged(client, platform, arch string, lag int) (clientRelease, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	slot := r.slots[releaseKey(client, platform, arch)]
	if slot == nil || len(slot.History) == 0 {
		return clientRelease{}, false
	}
	if lag < len(slot.History) {
		return slot.History[lag], true
	}
	return slot.History[len(slot.History)-1], true
}

func (r *releaseStore) status(client, platform, arch string) (time.Time, string) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if slot := r.slots[releaseKey(client, platform, arch)]; slot != nil {
		return slot.CheckedAt, slot.Error
	}
	return time.Time{}, ""
}

// resolveProfile 把选择解析为请求身份；同一请求的重试与换号复用这一份结果。
func (s *Server) resolveProfile(selection *ClientProfileSelection, deployment ProfileDeployment) (wireProfile, error) {
	chosen := defaultProfileSelection()
	if selection != nil && (selection.Mode != "" || selection.Client != "") {
		chosen = *selection
	}
	if err := chosen.validate(); err != nil {
		return wireProfile{}, err
	}
	var profile wireProfile
	if chosen.Mode == "custom" {
		parsed, err := parseCustomIdentity(chosen)
		if err != nil {
			return wireProfile{}, err
		}
		profile = parsed
	} else {
		arch := chosen.architecture()
		var release clientRelease
		if chosen.VersionMode == "fixed" {
			release = clientRelease{CodexVersion: chosen.CodexVersion, DesktopVersion: chosen.DesktopVersion, DesktopBuild: chosen.DesktopBuild}
		} else {
			latest, ok := s.releases.latest(chosen.Client, chosen.Platform, arch)
			if !ok {
				return wireProfile{}, errProfileReleaseUnavailable
			}
			release = latest
			if chosen.VersionLag > 0 {
				if lagged, ok := s.releases.lagged(chosen.Client, chosen.Platform, arch, chosen.VersionLag); ok {
					release = lagged
				}
			}
		}
		originator := chosen.Originator
		if originator == "" {
			switch {
			case chosen.Client == "desktop":
				originator = "Codex Desktop"
			case chosen.CliEntry == "tui":
				originator = "codex-tui"
			case chosen.CliEntry == "exec":
				originator = "codex_exec"
			default:
				originator = "codex_cli_rs"
			}
		}
		profile = wireProfile{
			Client: chosen.Client, Originator: originator, CodexVersion: release.CodexVersion,
			DesktopVersion: release.DesktopVersion, DesktopBuild: release.DesktopBuild,
			OsType: firstNonEmpty(chosen.OsType, platformOSType(chosen.Platform)), OsVersion: firstNonEmpty(chosen.OsVersion, platformOSVersion(chosen.Platform)),
			Arch: arch, Terminal: firstNonEmpty(chosen.Terminal, "unknown"), VerifiedAt: release.VerifiedAt,
		}
		if chosen.CliEntry != "" {
			// 入口后缀使用同一次解析的 Core 版本
			entry := map[string]string{"tui": "codex-tui", "exec": "codex_exec"}[chosen.CliEntry]
			profile.ExactUserAgent = fmt.Sprintf("%s (%s; %s)", profile.userAgent(), entry, profile.CodexVersion)
		}
	}
	profile.Residency, profile.RoutingOverr = deployment.Residency, deployment.AccountRoutingOverride
	return profile, nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

// profilePolicy 保存心跳下发的通用选择与部署配套头（后台请求使用）。
type profilePolicy struct {
	mu         sync.RWMutex
	selection  *ClientProfileSelection
	deployment ProfileDeployment
}

func (p *profilePolicy) set(selection *ClientProfileSelection, deployment ProfileDeployment) {
	p.mu.Lock()
	p.selection, p.deployment = selection, deployment
	p.mu.Unlock()
}

func (p *profilePolicy) get() (*ClientProfileSelection, ProfileDeployment) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.selection, p.deployment
}

// globalProfile 解析后台请求（额度、目录、探测、预热、Live）使用的通用身份；不可用时回退默认预设。
func (s *Server) globalProfile() wireProfile {
	selection, deployment := s.profilePolicy.get()
	profile, err := s.resolveProfile(selection, deployment)
	if err != nil {
		profile, _ = s.resolveProfile(nil, deployment)
	}
	return profile
}

// profileOr 返回请求冻结的身份；未携带（后台路径、测试）时使用通用身份。
func (s *Server) profileOr(profile wireProfile) wireProfile {
	if profile.Originator == "" {
		return s.globalProfile()
	}
	return profile
}

// withCoreVersion 用于模型目录：目录接口要求 UA 前缀与 version 指向请求的 client_version。
func (p wireProfile) withCoreVersion(version string) wireProfile {
	if version == "" || version == p.CodexVersion {
		return p
	}
	p.CodexVersion = version
	if p.ExactUserAgent != "" {
		p.ExactUserAgent = ""
		p.OsType, p.OsVersion = firstNonEmpty(p.OsType, "Mac OS"), firstNonEmpty(p.OsVersion, "15.7.1")
		p.Arch, p.Terminal = firstNonEmpty(p.Arch, "arm64"), firstNonEmpty(p.Terminal, "unknown")
		if p.Client == "desktop" && p.DesktopVersion == "" {
			p.Client = "cli"
		}
	}
	return p
}

// applyProfileIdentity 写入模型请求的认证与身份头：Authorization、chatgpt-account-id、originator、
// User-Agent、version，以及可选的 residency 与账号路由覆盖。
func applyProfileIdentity(header http.Header, account Account, profile wireProfile) {
	if account.APIKey != "" {
		// API Key 账号走 OpenAI 平台接口，不带 Codex 客户端身份
		header.Set("Authorization", "Bearer "+account.APIKey)
		return
	}
	if account.AccessToken != "" {
		header.Set("Authorization", "Bearer "+account.AccessToken)
	}
	header.Set("originator", profile.Originator)
	header.Set("User-Agent", profile.userAgent())
	header.Set("version", profile.CodexVersion)
	if account.ChatGPTAccountID != "" {
		header.Set("chatgpt-account-id", account.ChatGPTAccountID)
	}
	if profile.Residency != "" {
		header.Set("x-openai-internal-codex-residency", profile.Residency)
	}
	if profile.RoutingOverr != "" {
		header.Set("x-openai-account-routing-override", profile.RoutingOverr)
	}
}

// applyAccountIdentity：Core backend-client 的账号请求（/wham/*）只带 UA、认证与账号 ID。
func applyAccountIdentity(header http.Header, account Account, profile wireProfile) {
	header.Set("User-Agent", profile.userAgent())
	if account.AccessToken != "" {
		header.Set("Authorization", "Bearer "+account.AccessToken)
	}
	if account.ChatGPTAccountID != "" {
		header.Set("chatgpt-account-id", account.ChatGPTAccountID)
	}
}

// profilePreview：POST /internal/v1/profile/preview，控制面保存设置前预览解析结果（不发送上游请求）。
func (s *Server) profilePreview(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "use POST")
		return
	}
	var input struct {
		Selection  *ClientProfileSelection `json:"selection"`
		Deployment ProfileDeployment       `json:"deployment"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", err.Error())
		return
	}
	profile, err := s.resolveProfile(input.Selection, input.Deployment)
	if err != nil {
		status, code := http.StatusBadRequest, "client_profile_invalid"
		if errors.Is(err, errProfileReleaseUnavailable) {
			status, code = http.StatusServiceUnavailable, "client_profile_unavailable"
		}
		writeError(w, status, code, err.Error())
		return
	}
	header := http.Header{}
	applyProfileIdentity(header, Account{}, profile)
	headers := map[string]string{}
	for key := range header {
		headers[strings.ToLower(key)] = header.Get(key)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "profile": profile, "user_agent": profile.userAgent(), "headers": headers, "verified_at": profile.VerifiedAt})
}

// profileReleases：GET /internal/v1/profile/releases，返回每个预设组合当前采用的已核验版本与最近检查结果。
func (s *Server) profileReleases(w http.ResponseWriter, r *http.Request) {
	type entry struct {
		Client    string          `json:"client"`
		Platform  string          `json:"platform"`
		Arch      string          `json:"arch"`
		History   []clientRelease `json:"history"`
		CheckedAt time.Time       `json:"checked_at,omitempty"`
		Error     string          `json:"error,omitempty"`
	}
	var out []entry
	for _, client := range []string{"desktop", "cli"} {
		for _, platform := range []string{"macos", "linux", "windows"} {
			arch := platformArch(platform)
			s.releases.mu.RLock()
			slot := s.releases.slots[releaseKey(client, platform, arch)]
			var item entry
			if slot != nil {
				item = entry{History: append([]clientRelease(nil), slot.History...), CheckedAt: slot.CheckedAt, Error: slot.Error}
			}
			s.releases.mu.RUnlock()
			item.Client, item.Platform, item.Arch = client, platform, arch
			out = append(out, item)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "releases": out})
}
