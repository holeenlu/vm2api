package codexgateway

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestResolveProfilePresetsCustomAndLag(t *testing.T) {
	s := &Server{releases: newReleaseStore(""), profilePolicy: &profilePolicy{}}
	desktop, err := s.resolveProfile(nil, ProfileDeployment{Residency: "us"})
	if err != nil || desktop.userAgent() != "Codex Desktop/0.153.4 (Mac OS 15.7.1; arm64) unknown (Codex Desktop; 26.901.51231)" || desktop.Residency != "us" {
		t.Fatalf("default desktop=%+v ua=%q err=%v", desktop, desktop.userAgent(), err)
	}
	cli, err := s.resolveProfile(&ClientProfileSelection{Client: "cli", Platform: "linux", VersionMode: "latest", CliEntry: "tui"}, ProfileDeployment{})
	if err != nil || cli.Originator != "codex-tui" || cli.userAgent() != "codex-tui/0.155.0 (Linux 6.8.0; x86_64) unknown (codex-tui; 0.155.0)" {
		t.Fatalf("cli=%+v ua=%q err=%v", cli, cli.userAgent(), err)
	}
	fixed, err := s.resolveProfile(&ClientProfileSelection{Client: "desktop", Platform: "windows", VersionMode: "fixed", CodexVersion: "0.150.0", DesktopVersion: "26.800.1", DesktopBuild: "7000"}, ProfileDeployment{})
	if err != nil || fixed.CodexVersion != "0.150.0" || !strings.HasSuffix(fixed.userAgent(), "(Codex Desktop; 26.800.1)") || !strings.Contains(fixed.userAgent(), "(Windows 10.0.26100; x86_64)") {
		t.Fatalf("fixed=%+v err=%v", fixed, err)
	}
	custom, err := s.resolveProfile(&ClientProfileSelection{Mode: "custom", UserAgent: "codex_exec/0.149.0 (Ubuntu 24.04; aarch64) xterm-256color"}, ProfileDeployment{})
	if err != nil || custom.Originator != "codex_exec" || custom.CodexVersion != "0.149.0" || custom.OsType != "Ubuntu" || custom.Terminal != "xterm-256color" || custom.userAgent() != "codex_exec/0.149.0 (Ubuntu 24.04; aarch64) xterm-256color" {
		t.Fatalf("custom=%+v err=%v", custom, err)
	}
	if _, err := s.resolveProfile(&ClientProfileSelection{Mode: "custom", UserAgent: "my-agent/1"}, ProfileDeployment{}); err == nil {
		t.Fatal("unrecognized custom UA must name originator and version")
	}
	if _, err := s.resolveProfile(&ClientProfileSelection{Mode: "custom", UserAgent: "my-agent/1", Originator: "codex_cli_rs", CodexVersion: "0.150.0"}, ProfileDeployment{}); err != nil {
		t.Fatalf("custom with explicit identity: %v", err)
	}
	for _, invalid := range []ClientProfileSelection{
		{Client: "cli", Platform: "macos", VersionMode: "latest", VersionLag: 11},
		{Client: "desktop", Platform: "macos", VersionMode: "latest", CliEntry: "tui"},
		{Client: "cli", Platform: "bsd", VersionMode: "latest"},
		{Client: "desktop", Platform: "macos", VersionMode: "fixed", CodexVersion: "0.1"},
		{Mode: "custom", UserAgent: "codex_cli_rs/0.150.0 x", CodexVersion: "0.151.0"},
	} {
		if _, err := s.resolveProfile(&invalid, ProfileDeployment{}); err == nil {
			t.Fatalf("selection %+v should be rejected", invalid)
		}
	}
	now := time.Now()
	s.releases.record("cli", "linux", "x86_64", &clientRelease{CodexVersion: "0.156.0", VerifiedAt: now}, nil, now)
	s.releases.record("cli", "linux", "x86_64", &clientRelease{CodexVersion: "0.157.0", VerifiedAt: now}, nil, now)
	lagged, _ := s.resolveProfile(&ClientProfileSelection{Client: "cli", Platform: "linux", VersionMode: "latest", VersionLag: 1}, ProfileDeployment{})
	oldest, _ := s.resolveProfile(&ClientProfileSelection{Client: "cli", Platform: "linux", VersionMode: "latest", VersionLag: 10}, ProfileDeployment{})
	if lagged.CodexVersion != "0.156.0" || oldest.CodexVersion != "0.155.0" {
		t.Fatalf("lagged=%s oldest=%s", lagged.CodexVersion, oldest.CodexVersion)
	}
}

func TestExecuteSendsEnvelopeProfileAndSyncsGitContext(t *testing.T) {
	var got http.Header
	var body []byte
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
		raw, _ := io.ReadAll(r.Body)
		body = decompressed(r, raw)
		w.Header().Set("content-type", "application/json")
		_, _ = io.WriteString(w, `{"id":"resp_1"}`)
	}))
	defer upstream.Close()
	server, httpServer, cfg := newExecuteServer(t, upstream.URL, Account{ID: "acct_1", Enabled: true, AccessToken: "tok", ChatGPTAccountID: "chatgpt", Groups: []string{"1"}})
	git := `<external_codex_git_state><environment_context><git>{"appServerVersion":"0.1.0","appVersion":"1.0","sessionId":"s1","note":"a &amp; b"}</git></environment_context></external_codex_git_state>`
	request, _ := json.Marshal(map[string]any{"model": "gpt-test", "input": []any{map[string]any{"role": "user", "content": []any{map[string]any{"type": "input_text", "text": git}}}}})
	response := signedExecute(t, cfg, httpServer.URL, Envelope{
		Dispatch: "dispatch_profile", RequestID: "request_profile", Nonce: "profile", Operation: "responses", Protocol: "openai.responses", Model: "gpt-test",
		Body: request, Scope: Scope{GroupIDs: []int64{1}},
		ClientProfile:     &ClientProfileSelection{Client: "cli", Platform: "linux", VersionMode: "fixed", CodexVersion: "0.150.0"},
		ProfileDeployment: ProfileDeployment{AccountRoutingOverride: "route_a"},
	})
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		data, _ := io.ReadAll(response.Body)
		t.Fatalf("status=%d body=%s", response.StatusCode, data)
	}
	if got.Get("originator") != "codex_cli_rs" || got.Get("version") != "0.150.0" || got.Get("User-Agent") != "codex_cli_rs/0.150.0 (Linux 6.8.0; x86_64) unknown" || got.Get("x-openai-account-routing-override") != "route_a" {
		t.Fatalf("headers=%v", got)
	}
	text := string(body)
	if !strings.Contains(text, `\"appServerVersion\":\"0.150.0\"`) || !strings.Contains(text, `\"appVersion\":null`) || strings.Contains(text, `\"sessionId\":\"s1\"`) || !strings.Contains(text, "a &amp; b") {
		t.Fatalf("git context not synced: %s", text)
	}
	_ = server

	invalid := signedExecute(t, cfg, httpServer.URL, Envelope{
		Dispatch: "dispatch_profile_bad", RequestID: "request_profile_bad", Nonce: "profile_bad", Operation: "responses", Protocol: "openai.responses", Model: "gpt-test",
		Body: json.RawMessage(`{"model":"gpt-test"}`), Scope: Scope{GroupIDs: []int64{1}},
		ClientProfile: &ClientProfileSelection{Client: "cli", Platform: "linux", VersionMode: "latest", VersionLag: 20},
	})
	defer invalid.Body.Close()
	if invalid.StatusCode != http.StatusBadRequest || invalid.Header.Get(sendStateHeader) != sendStateNotSent {
		t.Fatalf("invalid profile status=%d state=%q", invalid.StatusCode, invalid.Header.Get(sendStateHeader))
	}
}

// --- 官方发布检查 ---

func machoCore(version string) []byte {
	data := make([]byte, 8192)
	copy(data, []byte{0xcf, 0xfa, 0xed, 0xfe})
	binary.LittleEndian.PutUint32(data[4:8], 0x0100000c)
	copy(data[6000:], "codex-mcp-client/"+version+" (x)")
	return data
}

func peCore(version string) []byte {
	data := make([]byte, 8192)
	copy(data, "MZ")
	binary.LittleEndian.PutUint32(data[60:64], 128)
	copy(data[128:], "PE\x00\x00")
	binary.LittleEndian.PutUint16(data[132:134], 0x8664)
	// 版本跨 256 KiB 读取边界之外仍能找到
	copy(data[5000:], "codex-mcp-client/"+version+"\x00")
	return data
}

func asarFile(pkg []byte) []byte {
	header, _ := json.Marshal(map[string]any{"files": map[string]any{"index.js": map[string]any{"size": 4, "offset": "0"}, "package.json": map[string]any{"size": len(pkg), "offset": "4"}}})
	pad := (4 - len(header)%4) % 4
	payload := binary.LittleEndian.AppendUint32(nil, uint32(len(header)))
	payload = append(append(payload, header...), make([]byte, pad)...)
	out := binary.LittleEndian.AppendUint32(nil, 4)
	out = binary.LittleEndian.AppendUint32(out, uint32(4+len(payload)))
	out = binary.LittleEndian.AppendUint32(out, uint32(len(payload)))
	out = append(out, payload...)
	return append(append(out, "code"...), pkg...)
}

func zipOf(t *testing.T, files map[string][]byte) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for name, data := range files {
		entry, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = entry.Write(data)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

type releaseFixture struct {
	mu        atomic.Value // map[string][]byte
	fullReads atomic.Int64
}

func (f *releaseFixture) set(files map[string][]byte) { f.mu.Store(files) }

func (f *releaseFixture) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	files := f.mu.Load().(map[string][]byte)
	data, ok := files[r.URL.Path]
	if !ok {
		http.NotFound(w, r)
		return
	}
	if r.Header.Get("Range") != "bytes=0-0" && r.Header.Get("Range") != "" {
		f.fullReads.Add(1)
	}
	w.Header().Set("ETag", fmt.Sprintf(`"%d-%x"`, len(data), data[len(data)/2]))
	http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(data))
}

func TestRefreshReleasesVerifiesOfficialArtifacts(t *testing.T) {
	deb, err := os.ReadFile("testdata/release/chatgpt_amd64.deb")
	if err != nil {
		t.Fatal(err)
	}
	pkg := []byte(`{"name":"openai-codex-electron","version":"26.920.5","codexBuildNumber":"9950","codexBuildFlavor":"prod"}`)
	msix := zipOf(t, map[string][]byte{
		"AppxManifest.xml":        []byte(`<?xml version="1.0" encoding="utf-8"?><Package><Identity Name="OpenAI.Codex" ProcessorArchitecture="x64" Version="26.920.5.0"/></Package>`),
		"app/resources/app.asar":  asarFile(pkg),
		"app/resources/codex.exe": peCore("0.156.0-alpha.3"),
	})
	mac := zipOf(t, map[string][]byte{"Codex.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex": machoCore("0.156.0")})
	fixture := &releaseFixture{}
	upstream := httptest.NewServer(fixture)
	defer upstream.Close()
	npm := func(version string) []byte {
		deps := map[string]string{}
		for _, target := range []string{"darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"} {
			deps["@openai/codex-"+target] = "npm:@openai/codex@" + version + "-" + target
		}
		data, _ := json.Marshal(map[string]any{"name": "@openai/codex", "version": version, "optionalDependencies": deps})
		return data
	}
	appcast := func(version, build string, length int) []byte {
		return []byte(fmt.Sprintf(`<?xml version="1.0"?><rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><item><sparkle:version>%s</sparkle:version><sparkle:shortVersionString>%s</sparkle:shortVersionString><enclosure url="%s/mac.zip" length="%d" sparkle:edSignature="sig"/><sparkle:deltas><enclosure url="%s/mac.delta" sparkle:deltaFrom="1" length="7" sparkle:edSignature="sig"/></sparkle:deltas></item></channel></rss>`, build, version, upstream.URL, length, upstream.URL))
	}
	fixture.set(map[string][]byte{"/npm": npm("0.156.0"), "/appcast.xml": appcast("26.920.40", "9960", len(mac)), "/mac.zip": mac, "/win-x64.msix": msix, "/linux-x64.deb": deb})
	fetcher := newReleaseFetcher()
	fetcher.npmURL, fetcher.appcastURL = upstream.URL+"/npm", upstream.URL+"/appcast.xml"
	fetcher.allowHost = func(string) bool { return true }
	fetcher.artifact = func(platform, arch string) string {
		return upstream.URL + map[string]string{"windows|x86_64": "/win-x64.msix", "linux|x86_64": "/linux-x64.deb"}[platform+"|"+arch]
	}
	s := &Server{releases: newReleaseStore(""), releaseFetcher: fetcher}
	s.refreshReleases(context.Background())
	check := func(client, platform, arch, codex, desktop, build string) {
		t.Helper()
		release, _ := s.releases.latest(client, platform, arch)
		if release.CodexVersion != codex || release.DesktopVersion != desktop || release.DesktopBuild != build {
			_, failure := s.releases.status(client, platform, arch)
			t.Fatalf("%s/%s/%s release=%+v error=%s", client, platform, arch, release, failure)
		}
	}
	check("cli", "windows", "arm64", "0.156.0", "", "")
	check("desktop", "macos", "arm64", "0.156.0", "26.920.40", "9960")
	check("desktop", "windows", "x86_64", "0.156.0-alpha.3", "26.920.5", "9950")
	check("desktop", "linux", "x86_64", "0.156.0-alpha.1", "26.920.1", "9901")
	// arm64 制品不存在：保留种子版本并记录错误
	check("desktop", "linux", "arm64", "0.155.0-alpha.9", "26.915.31029", "9771")
	if _, failure := s.releases.status("desktop", "linux", "arm64"); failure == "" {
		t.Fatal("missing artifact must record an error")
	}

	// 制品 size+ETag 未变时复用已核验版本，不再读取正文；构建号回退被拒绝
	reads := fixture.fullReads.Load()
	fixture.set(map[string][]byte{"/npm": npm("0.155.9"), "/appcast.xml": appcast("26.900.1", "9000", len(mac)), "/mac.zip": mac, "/win-x64.msix": msix, "/linux-x64.deb": deb})
	s.refreshReleases(context.Background())
	if fixture.fullReads.Load() != reads {
		t.Fatalf("unchanged artifacts were downloaded again: %d -> %d", reads, fixture.fullReads.Load())
	}
	check("desktop", "macos", "arm64", "0.156.0", "26.920.40", "9960")
	if _, failure := s.releases.status("desktop", "macos", "arm64"); !strings.Contains(failure, "rolled back") {
		t.Fatalf("rollback error=%q", failure)
	}
	check("desktop", "windows", "x86_64", "0.156.0-alpha.3", "26.920.5", "9950")
	// npm 返回更旧的版本时作为新观察放到首位（CLI 由 npm 稳定标签决定）
	check("cli", "linux", "x86_64", "0.155.9", "", "")
}

func TestReadCoreVersionRejectsWrongBinary(t *testing.T) {
	if _, err := readCoreVersion(bytes.NewReader(machoCore("0.156.0")), 8192, "linux", "x86_64"); err == nil {
		t.Fatal("Mach-O accepted as ELF")
	}
	core := peCore("0.156.0")
	binary.LittleEndian.PutUint16(core[132:134], 0xaa64)
	if _, err := readCoreVersion(bytes.NewReader(core), 8192, "windows", "x86_64"); err == nil {
		t.Fatal("arm64 PE accepted for x86_64")
	}
	// 版本跨扫描分块
	data := make([]byte, 300<<10)
	copy(data, []byte{0xcf, 0xfa, 0xed, 0xfe})
	binary.LittleEndian.PutUint32(data[4:8], 0x0100000c)
	anchor := "codex-mcp-client/0.157.2 "
	copy(data[4096+256<<10-10:], anchor)
	if version, err := readCoreVersion(bytes.NewReader(data), int64(len(data)), "macos", "arm64"); err != nil || version != "0.157.2" {
		t.Fatalf("version=%q err=%v", version, err)
	}
}
