package codexgateway

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// 官方发布检查（对齐 codex-proxy-rs profile/cli_release.rs、desktop_artifact.rs、platform_release）：
//   - CLI：npm `@openai/codex` 稳定标签，且六个平台依赖都指向同一版本；
//   - macOS Desktop：appcast 的版本与构建号 + 同一 ZIP 内 bundled Core（Mach-O arm64）中的版本；
//   - Windows：MSIX 的 AppxManifest、app.asar 内 package.json 与 codex.exe（PE）；
//   - Linux：DEB 的 data.tar.xz（按索引随机读取）中的 app.asar 与 codex（ELF）。
//
// 安装包只通过 HTTP Range 读取所需片段；Windows/Linux 按 size+ETag 判断是否需要重新核验。
const (
	releaseCheckInterval   = 24 * time.Hour
	officialArtifactHost   = "persistent.oaistatic.com"
	desktopAppcastURL      = "https://persistent.oaistatic.com/codex-app-prod/appcast.xml"
	npmCodexLatestURL      = "https://registry.npmjs.org/@openai%2Fcodex/latest"
	coreVersionAnchor      = "codex-mcp-client/"
	maxCoreBytes           = 512 << 20
	maxArtifactRangeBudget = 768 << 20
	rangeChunkBytes        = 1 << 20
	macCorePathSuffix      = "/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"
)

var errArtifact = errors.New("official artifact is invalid or incomplete")

type releaseFetcher struct {
	client     *http.Client
	appcastURL string
	npmURL     string
	artifact   func(platform, arch string) string
	allowHost  func(host string) bool
}

func newReleaseFetcher() *releaseFetcher {
	return &releaseFetcher{
		client:     &http.Client{Timeout: 60 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
		appcastURL: desktopAppcastURL, npmURL: npmCodexLatestURL,
		artifact: func(platform, arch string) string {
			paths := map[string]string{"windows|x86_64": "ChatGPT-x64.msix", "windows|arm64": "ChatGPT-arm64.msix", "linux|x86_64": "linux/deb/latest/chatgpt_amd64.deb", "linux|arm64": "linux/deb/latest/chatgpt_arm64.deb"}
			return "https://persistent.oaistatic.com/codex-app-prod/" + paths[platform+"|"+arch]
		},
		allowHost: func(host string) bool { return host == officialArtifactHost },
	}
}

func (f *releaseFetcher) get(ctx context.Context, target string, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	resp, err := f.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("release source returned HTTP %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil || int64(len(data)) > limit {
		return nil, errArtifact
	}
	return data, nil
}

// fetchCLIRelease 校验 npm 稳定标签与六个平台依赖来自同一次发布。
func (f *releaseFetcher) fetchCLIRelease(ctx context.Context) (string, error) {
	data, err := f.get(ctx, f.npmURL, 256<<10)
	if err != nil {
		return "", err
	}
	var release struct {
		Name                 string            `json:"name"`
		Version              string            `json:"version"`
		OptionalDependencies map[string]string `json:"optionalDependencies"`
	}
	if json.Unmarshal(data, &release) != nil || release.Name != "@openai/codex" || !validSemver(release.Version) || strings.ContainsAny(release.Version, "-+") {
		return "", errArtifact
	}
	for _, target := range []string{"darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"} {
		if release.OptionalDependencies["@openai/codex-"+target] != "npm:@openai/codex@"+release.Version+"-"+target {
			return "", errArtifact
		}
	}
	return release.Version, nil
}

type appcastRelease struct {
	version, build, url string
	length              int64
	signed              bool
}

func xmlAttr(attrs []xml.Attr, local string) string {
	for _, attr := range attrs {
		if attr.Name.Local == local {
			return attr.Value
		}
	}
	return ""
}

// parseAppcast 取第一个 item 的 shortVersionString、version 与完整包 enclosure（url、length、edSignature）；
// sparkle:deltas 内的增量包 enclosure 不是完整 ZIP，跳过。
func parseAppcast(data []byte) (appcastRelease, error) {
	decoder := xml.NewDecoder(bytes.NewReader(data))
	var out appcastRelease
	inItem, field, deltas := false, "", 0
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return appcastRelease{}, errArtifact
		}
		switch t := token.(type) {
		case xml.StartElement:
			if t.Name.Local == "item" {
				if inItem {
					return out, nil
				}
				inItem = true
			}
			if !inItem {
				continue
			}
			field = t.Name.Local
			if t.Name.Local == "deltas" {
				deltas++
			}
			if t.Name.Local == "enclosure" && deltas == 0 {
				out.url = xmlAttr(t.Attr, "url")
				out.length, _ = strconv.ParseInt(xmlAttr(t.Attr, "length"), 10, 64)
				out.signed = xmlAttr(t.Attr, "edSignature") != ""
				if out.version == "" {
					out.version = xmlAttr(t.Attr, "shortVersionString")
				}
				if out.build == "" {
					out.build = xmlAttr(t.Attr, "version")
				}
			}
		case xml.CharData:
			text := strings.TrimSpace(string(t))
			switch {
			case !inItem || text == "":
			case field == "shortVersionString":
				out.version = text
			case field == "version":
				out.build = text
			}
		case xml.EndElement:
			field = ""
			if t.Name.Local == "deltas" && deltas > 0 {
				deltas--
			}
			if t.Name.Local == "item" {
				return out, nil
			}
		}
	}
	if !inItem {
		return appcastRelease{}, errArtifact
	}
	return out, nil
}

// rangeFile 是基于 HTTP Range 的 io.ReaderAt，按 1 MiB 分块缓存最近访问的片段并限制总下载量。
type rangeFile struct {
	ctx      context.Context
	client   *http.Client
	url      string
	size     int64
	etag     string
	mu       sync.Mutex
	cache    map[int64][]byte
	order    []int64
	budget   int64
	consumed int64
}

func (f *releaseFetcher) openRange(ctx context.Context, target string) (*rangeFile, error) {
	parsed, err := url.Parse(target)
	if err != nil || (parsed.Scheme != "https" && !strings.HasPrefix(target, "http://127.0.0.1")) || !f.allowHost(parsed.Hostname()) {
		return nil, errArtifact
	}
	file := &rangeFile{ctx: ctx, client: f.client, url: target, cache: map[int64][]byte{}, budget: maxArtifactRangeBudget}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Range", "bytes=0-0")
	resp, err := f.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1))
	if resp.StatusCode != http.StatusPartialContent {
		return nil, fmt.Errorf("artifact range returned HTTP %d", resp.StatusCode)
	}
	_, total, ok := strings.Cut(resp.Header.Get("Content-Range"), "/")
	if !ok {
		return nil, errArtifact
	}
	file.size, err = strconv.ParseInt(total, 10, 64)
	if err != nil || file.size <= 0 {
		return nil, errArtifact
	}
	file.etag = resp.Header.Get("ETag")
	return file, nil
}

func (r *rangeFile) identity() string { return fmt.Sprintf("%d|%s", r.size, r.etag) }

func (r *rangeFile) chunk(index int64) ([]byte, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if data, ok := r.cache[index]; ok {
		return data, nil
	}
	start := index * rangeChunkBytes
	end := start + rangeChunkBytes - 1
	if end >= r.size {
		end = r.size - 1
	}
	if r.consumed+(end-start+1) > r.budget {
		return nil, errors.New("artifact range budget exceeded")
	}
	req, err := http.NewRequestWithContext(r.ctx, http.MethodGet, r.url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", start, end))
	if r.etag != "" {
		req.Header.Set("If-Range", r.etag)
	}
	resp, err := r.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusPartialContent {
		// 制品在读取期间被替换（If-Range 不匹配时服务端返回 200）
		return nil, errors.New("artifact changed during verification")
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, end-start+2))
	if err != nil || int64(len(data)) != end-start+1 {
		return nil, errArtifact
	}
	r.consumed += int64(len(data))
	r.cache[index] = data
	r.order = append(r.order, index)
	if len(r.order) > 8 {
		delete(r.cache, r.order[0])
		r.order = r.order[1:]
	}
	return data, nil
}

func (r *rangeFile) ReadAt(p []byte, offset int64) (int, error) {
	if offset < 0 || offset >= r.size {
		return 0, io.EOF
	}
	n := 0
	for n < len(p) && offset+int64(n) < r.size {
		position := offset + int64(n)
		data, err := r.chunk(position / rangeChunkBytes)
		if err != nil {
			return n, err
		}
		n += copy(p[n:], data[position%rangeChunkBytes:])
	}
	if n < len(p) {
		return n, io.EOF
	}
	return n, nil
}

// coreScanner 在 Core 可执行文件中查找 `codex-mcp-client/<semver>`（跨分块保留尾部）。
type coreScanner struct{ carry []byte }

func (c *coreScanner) push(data []byte, final bool) string {
	window := append(c.carry, data...)
	search := 0
	for {
		index := bytes.Index(window[search:], []byte(coreVersionAnchor))
		if index < 0 {
			break
		}
		start := search + index + len(coreVersionAnchor)
		end := start
		for end < len(window) && end-start <= 64 {
			b := window[end]
			if !(b >= '0' && b <= '9' || b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z' || b == '.' || b == '-' || b == '+') {
				break
			}
			end++
		}
		if end == len(window) && !final {
			// 版本可能跨分块，留到下一块再判断
			c.carry = append([]byte(nil), window[search+index:]...)
			return ""
		}
		if version := strings.TrimRight(string(window[start:end]), ".-+"); validSemver(version) {
			return version
		}
		search = start
	}
	keep := len(coreVersionAnchor) + 64
	if len(window) < keep {
		keep = len(window)
	}
	c.carry = append([]byte(nil), window[len(window)-keep:]...)
	return ""
}

// readCoreVersion 校验可执行文件头（Mach-O arm64 / ELF / PE 与架构一致）并扫描版本。
func readCoreVersion(reader io.Reader, size int64, platform, arch string) (string, error) {
	if size < 4096 || size > maxCoreBytes {
		return "", errArtifact
	}
	header := make([]byte, 4096)
	if _, err := io.ReadFull(reader, header); err != nil {
		return "", err
	}
	valid := false
	switch platform {
	case "macos":
		valid = bytes.Equal(header[:4], []byte{0xcf, 0xfa, 0xed, 0xfe}) && binary.LittleEndian.Uint32(header[4:8]) == 0x0100000c
	case "linux":
		machine := uint16(62)
		if arch == "arm64" {
			machine = 183
		}
		valid = bytes.Equal(header[:6], []byte("\x7fELF\x02\x01")) && binary.LittleEndian.Uint16(header[18:20]) == machine
	case "windows":
		offset := int(binary.LittleEndian.Uint32(header[60:64]))
		machine := uint16(0x8664)
		if arch == "arm64" {
			machine = 0xaa64
		}
		valid = bytes.Equal(header[:2], []byte("MZ")) && offset+6 <= len(header) && bytes.Equal(header[offset:offset+4], []byte("PE\x00\x00")) && binary.LittleEndian.Uint16(header[offset+4:offset+6]) == machine
	}
	if !valid {
		return "", errArtifact
	}
	var scanner coreScanner
	if version := scanner.push(header, false); version != "" {
		return version, nil
	}
	remaining := io.LimitReader(reader, size-4096)
	buffer := make([]byte, 256<<10)
	for {
		n, err := remaining.Read(buffer)
		if n > 0 {
			if version := scanner.push(buffer[:n], false); version != "" {
				return version, nil
			}
		}
		if err == io.EOF {
			if version := scanner.push(nil, true); version != "" {
				return version, nil
			}
			return "", errArtifact
		}
		if err != nil {
			return "", err
		}
	}
}

// fetchMacDesktop：appcast 版本须来自已签名的官方 ZIP；构建号回退视为异常。
func (f *releaseFetcher) fetchMacDesktop(ctx context.Context, previous clientRelease) (clientRelease, error) {
	data, err := f.get(ctx, f.appcastURL, 1<<20)
	if err != nil {
		return clientRelease{}, err
	}
	release, err := parseAppcast(data)
	if err != nil || !release.signed || release.url == "" || release.length <= 0 || !numericDottedVersion(release.version) {
		return clientRelease{}, errArtifact
	}
	build, err := strconv.ParseUint(release.build, 10, 64)
	if err != nil || build == 0 {
		return clientRelease{}, errArtifact
	}
	if previousBuild, err := strconv.ParseUint(previous.DesktopBuild, 10, 64); err == nil {
		switch {
		case build < previousBuild:
			return clientRelease{}, errors.New("official desktop release rolled back")
		case build == previousBuild:
			if release.version != previous.DesktopVersion {
				return clientRelease{}, errors.New("official desktop release is inconsistent")
			}
			previous.VerifiedAt = time.Now().UTC()
			return previous, nil
		}
	}
	file, err := f.openRange(ctx, release.url)
	if err != nil {
		return clientRelease{}, err
	}
	if file.size != release.length {
		return clientRelease{}, errArtifact
	}
	archive, err := zip.NewReader(file, file.size)
	if err != nil {
		return clientRelease{}, errArtifact
	}
	for _, entry := range archive.File {
		if !strings.HasSuffix(entry.Name, macCorePathSuffix) {
			continue
		}
		reader, err := entry.Open()
		if err != nil {
			return clientRelease{}, errArtifact
		}
		version, err := readCoreVersion(reader, int64(entry.UncompressedSize64), "macos", "arm64")
		reader.Close()
		if err != nil {
			return clientRelease{}, err
		}
		return clientRelease{CodexVersion: version, DesktopVersion: release.version, DesktopBuild: release.build, VerifiedAt: time.Now().UTC()}, nil
	}
	return clientRelease{}, errArtifact
}

// asarPackage 读取 app.asar 中 package.json 的位置（相对 asar 起点）。
func asarPackage(reader io.Reader, size int64) (int64, int64, int64, error) {
	prefix := make([]byte, 16)
	if _, err := io.ReadFull(reader, prefix); err != nil {
		return 0, 0, 0, err
	}
	headerSize := int64(binary.LittleEndian.Uint32(prefix[4:8]))
	jsonSize := int64(binary.LittleEndian.Uint32(prefix[12:16]))
	if binary.LittleEndian.Uint32(prefix[0:4]) != 4 || headerSize < 8 || headerSize > 16<<20 || jsonSize > headerSize-8 || headerSize+8 > size {
		return 0, 0, 0, errArtifact
	}
	data := make([]byte, jsonSize)
	if _, err := io.ReadFull(reader, data); err != nil {
		return 0, 0, 0, err
	}
	var header struct {
		Files map[string]struct {
			Offset   string          `json:"offset"`
			Size     int64           `json:"size"`
			Unpacked json.RawMessage `json:"unpacked"`
			Link     json.RawMessage `json:"link"`
		} `json:"files"`
	}
	if json.Unmarshal(data, &header) != nil {
		return 0, 0, 0, errArtifact
	}
	pkg, ok := header.Files["package.json"]
	if !ok || pkg.Unpacked != nil || pkg.Link != nil || pkg.Size <= 0 || pkg.Size > 256<<10 {
		return 0, 0, 0, errArtifact
	}
	offset, err := strconv.ParseInt(pkg.Offset, 10, 64)
	if err != nil {
		return 0, 0, 0, errArtifact
	}
	offset += headerSize + 8
	if offset+pkg.Size > size {
		return 0, 0, 0, errArtifact
	}
	return offset, pkg.Size, 16 + jsonSize, nil
}

// readElectronPackage 校验 package.json：openai-codex-electron、prod 构建、SemVer 版本与非零构建号。
func readElectronPackage(reader io.Reader, length int64) (clientRelease, error) {
	data := make([]byte, length)
	if _, err := io.ReadFull(reader, data); err != nil {
		return clientRelease{}, err
	}
	var pkg struct {
		Name        string `json:"name"`
		Version     string `json:"version"`
		BuildNumber string `json:"codexBuildNumber"`
		BuildFlavor string `json:"codexBuildFlavor"`
	}
	if json.Unmarshal(data, &pkg) != nil || pkg.Name != "openai-codex-electron" || pkg.BuildFlavor != "prod" || !validSemver(pkg.Version) {
		return clientRelease{}, errArtifact
	}
	if build, err := strconv.ParseUint(pkg.BuildNumber, 10, 64); err != nil || build == 0 {
		return clientRelease{}, errArtifact
	}
	return clientRelease{DesktopVersion: pkg.Version, DesktopBuild: pkg.BuildNumber}, nil
}

func readWindowsArtifact(file io.ReaderAt, size int64, arch string) (clientRelease, error) {
	archive, err := zip.NewReader(file, size)
	if err != nil || len(archive.File) > 20000 {
		return clientRelease{}, errArtifact
	}
	byName := map[string]*zip.File{}
	for _, entry := range archive.File {
		byName[entry.Name] = entry
	}
	manifest, ok := byName["AppxManifest.xml"]
	if !ok {
		return clientRelease{}, errArtifact
	}
	reader, err := manifest.Open()
	if err != nil {
		return clientRelease{}, errArtifact
	}
	data, _ := io.ReadAll(io.LimitReader(reader, 128<<10+1))
	reader.Close()
	expected := map[string]string{"arm64": "arm64", "x86_64": "x64"}[arch]
	if len(data) > 128<<10 || expected == "" {
		return clientRelease{}, errArtifact
	}
	decoder := xml.NewDecoder(bytes.NewReader(bytes.TrimPrefix(data, []byte("\xef\xbb\xbf"))))
	identityOK := false
	for {
		token, err := decoder.Token()
		if err != nil {
			break
		}
		if start, ok := token.(xml.StartElement); ok && start.Name.Local == "Identity" {
			identityOK = xmlAttr(start.Attr, "Name") == "OpenAI.Codex" && xmlAttr(start.Attr, "ProcessorArchitecture") == expected
			break
		}
	}
	if !identityOK {
		return clientRelease{}, errArtifact
	}
	asar, ok := byName["app/resources/app.asar"]
	if !ok {
		return clientRelease{}, errArtifact
	}
	reader, err = asar.Open()
	if err != nil {
		return clientRelease{}, errArtifact
	}
	offset, length, consumed, err := asarPackage(reader, int64(asar.UncompressedSize64))
	if err == nil && offset > 128<<20 {
		err = errArtifact
	}
	var release clientRelease
	if err == nil {
		if _, err = io.CopyN(io.Discard, reader, offset-consumed); err == nil {
			release, err = readElectronPackage(reader, length)
		}
	}
	reader.Close()
	if err != nil {
		return clientRelease{}, err
	}
	core, ok := byName["app/resources/codex.exe"]
	if !ok {
		return clientRelease{}, errArtifact
	}
	reader, err = core.Open()
	if err != nil {
		return clientRelease{}, errArtifact
	}
	defer reader.Close()
	release.CodexVersion, err = readCoreVersion(reader, int64(core.UncompressedSize64), "windows", arch)
	return release, err
}

func readLinuxArtifact(file io.ReaderAt, size int64, arch string) (clientRelease, error) {
	magic := make([]byte, 8)
	if _, err := file.ReadAt(magic, 0); err != nil || string(magic) != "!<arch>\n" {
		return clientRelease{}, errArtifact
	}
	offset := int64(8)
	var dataOffset, dataSize int64
	for i := 0; i < 16 && offset+60 <= size; i++ {
		header := make([]byte, 60)
		if _, err := file.ReadAt(header, offset); err != nil {
			return clientRelease{}, err
		}
		if string(header[58:]) != "`\n" {
			return clientRelease{}, errArtifact
		}
		entrySize, err := strconv.ParseInt(strings.TrimSpace(string(header[48:58])), 10, 64)
		if err != nil || offset+60+entrySize > size {
			return clientRelease{}, errArtifact
		}
		if strings.TrimSpace(string(header[:16])) == "data.tar.xz" {
			dataOffset, dataSize = offset+60, entrySize
			break
		}
		offset += 60 + entrySize + entrySize%2
	}
	if dataSize == 0 {
		return clientRelease{}, errArtifact
	}
	xzReader, err := newIndexedXZ(file, uint64(dataOffset), uint64(dataSize))
	if err != nil {
		return clientRelease{}, err
	}
	archive := tar.NewReader(xzReader)
	var asarAt, asarSize, coreAt, coreSize int64 = -1, 0, -1, 0
	for i := 0; i < 30000 && (asarAt < 0 || coreAt < 0); i++ {
		header, err := archive.Next()
		if err != nil {
			break
		}
		path := strings.TrimPrefix(header.Name, "./")
		if path != "usr/lib/chatgpt/resources/app.asar" && path != "usr/lib/chatgpt/resources/codex" {
			continue
		}
		if header.Typeflag != tar.TypeReg {
			return clientRelease{}, errArtifact
		}
		position, _ := xzReader.Seek(0, io.SeekCurrent)
		if strings.HasSuffix(path, "app.asar") {
			asarAt, asarSize = position, header.Size
		} else {
			coreAt, coreSize = position, header.Size
		}
	}
	if asarAt < 0 || coreAt < 0 {
		return clientRelease{}, errArtifact
	}
	if _, err := xzReader.Seek(asarAt, io.SeekStart); err != nil {
		return clientRelease{}, err
	}
	pkgOffset, pkgLength, _, err := asarPackage(xzReader, asarSize)
	if err != nil {
		return clientRelease{}, err
	}
	if _, err := xzReader.Seek(asarAt+pkgOffset, io.SeekStart); err != nil {
		return clientRelease{}, err
	}
	release, err := readElectronPackage(xzReader, pkgLength)
	if err != nil {
		return clientRelease{}, err
	}
	if _, err := xzReader.Seek(coreAt, io.SeekStart); err != nil {
		return clientRelease{}, err
	}
	release.CodexVersion, err = readCoreVersion(xzReader, coreSize, "linux", arch)
	return release, err
}

// fetchPlatformDesktop：Windows MSIX / Linux DEB；size+ETag 未变化时复用已核验版本，构建号回退拒绝。
func (f *releaseFetcher) fetchPlatformDesktop(ctx context.Context, platform, arch string, previous clientRelease) (clientRelease, error) {
	file, err := f.openRange(ctx, f.artifact(platform, arch))
	if err != nil {
		return clientRelease{}, err
	}
	if previous.Identity != "" && previous.Identity == file.identity() {
		previous.VerifiedAt = time.Now().UTC()
		return previous, nil
	}
	var release clientRelease
	if platform == "windows" {
		release, err = readWindowsArtifact(file, file.size, arch)
	} else {
		release, err = readLinuxArtifact(file, file.size, arch)
	}
	if err != nil {
		return clientRelease{}, err
	}
	next, _ := strconv.ParseUint(release.DesktopBuild, 10, 64)
	if before, err := strconv.ParseUint(previous.DesktopBuild, 10, 64); err == nil && next < before {
		return clientRelease{}, errors.New("official desktop release rolled back")
	}
	release.Identity, release.VerifiedAt = file.identity(), time.Now().UTC()
	return release, nil
}

// refreshReleases 检查全部六套预设的官方发布；失败只记录错误，保留同组合上次有效版本。
// refreshReleases 依次核验三类官方发布（测试与手动触发使用）；返回是否全部成功。
func (s *Server) refreshReleases(ctx context.Context) bool {
	cli := s.refreshCLIRelease(ctx)
	mac := s.refreshMacRelease(ctx)
	platforms := s.refreshPlatformReleases(ctx)
	return cli && mac && platforms
}

func (s *Server) refreshCLIRelease(ctx context.Context) bool {
	now := time.Now().UTC()
	checkCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	version, err := s.releaseFetcher.fetchCLIRelease(checkCtx)
	if ctx.Err() != nil {
		// 退出中被取消：不记录核验结果
		return false
	}
	for _, target := range cliTargets {
		if err == nil {
			s.releases.record("cli", target[0], target[1], &clientRelease{CodexVersion: version, VerifiedAt: now}, nil, now)
		} else {
			s.releases.record("cli", target[0], target[1], nil, err, now)
		}
	}
	return err == nil
}

func (s *Server) refreshMacRelease(ctx context.Context) bool {
	now := time.Now().UTC()
	checkCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	previous, _ := s.releases.latest("desktop", "macos", "arm64")
	release, err := s.releaseFetcher.fetchMacDesktop(checkCtx, previous)
	if ctx.Err() != nil {
		return false
	}
	if err == nil {
		s.releases.record("desktop", "macos", "arm64", &release, nil, now)
	} else {
		s.releases.record("desktop", "macos", "arm64", nil, err, now)
	}
	return err == nil
}

func (s *Server) refreshPlatformReleases(ctx context.Context) bool {
	now := time.Now().UTC()
	checkCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	ok := true
	for _, platform := range []string{"windows", "linux"} {
		for _, arch := range []string{"x86_64", "arm64"} {
			previous, _ := s.releases.latest("desktop", platform, arch)
			release, err := s.releaseFetcher.fetchPlatformDesktop(checkCtx, platform, arch, previous)
			if ctx.Err() != nil {
				return false
			}
			if err == nil {
				s.releases.record("desktop", platform, arch, &release, nil, now)
			} else {
				s.releases.record("desktop", platform, arch, nil, err, now)
				ok = false
			}
		}
	}
	return ok
}

// 官方发布核验调度（对齐 CPR gateway-host workers.rs）：CLI、macOS Desktop、Windows/Linux Desktop 三个任务各自
// 启动即执行，成功后间隔 24 小时，失败按 1s 起翻倍、最长 60s 的退避重试。
const (
	releaseRetryBase = time.Second
	releaseRetryMax  = 60 * time.Second
)

func (s *Server) releaseLoop(ctx context.Context) {
	for _, task := range []func(context.Context) bool{s.refreshCLIRelease, s.refreshMacRelease, s.refreshPlatformReleases} {
		go releaseTaskLoop(ctx, task)
	}
	<-ctx.Done()
}

func releaseTaskLoop(ctx context.Context, task func(context.Context) bool) {
	backoff := releaseRetryBase
	for {
		wait := releaseCheckInterval
		if task(ctx) {
			backoff = releaseRetryBase
		} else {
			wait, backoff = backoff, min(backoff*2, releaseRetryMax)
		}
		if !sleepContext(ctx, wait) {
			return
		}
	}
}
