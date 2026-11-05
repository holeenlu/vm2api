package codexgateway

import (
	"embed"
	"encoding/json"
	"net/http"
)

// 设置描述（统一控制面重构 P4.4，设计 5.2、第 10 节）：Codex 本地设置与账号 BPS 设置的字段、类型、范围、分组与文案 key。
// 源文件在仓库 src/shared/executor-schema/，这里内嵌同一份副本（测试保证逐字节一致），经
// GET /internal/v1/schema/settings、/schema/account 提供，并在能力描述中报告版本；控制面按描述在服务端校验保存。

//go:embed schema/codex-settings.json schema/codex-account.json
var schemaFiles embed.FS

type schemaInfo struct {
	Version int    `json:"version"`
	URL     string `json:"url"`
}

func schemaDocument(name string) []byte {
	data, _ := schemaFiles.ReadFile("schema/" + name)
	return data
}

func schemaVersion(name string) int {
	var doc struct {
		Version int `json:"version"`
	}
	_ = json.Unmarshal(schemaDocument(name), &doc)
	return doc.Version
}

// schemaCapabilities 写入能力描述与注册载荷
func schemaCapabilities() map[string]schemaInfo {
	return map[string]schemaInfo{
		"settings_schema": {Version: schemaVersion("codex-settings.json"), URL: "/internal/v1/schema/settings"},
		"account_schema":  {Version: schemaVersion("codex-account.json"), URL: "/internal/v1/schema/account"},
	}
}

func (s *Server) schemaHandler(name string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "use GET")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(schemaDocument(name))
	}
}

// accountAuthorizations 是本执行服务支持的授权方式（P6.3，设计 5.2）：控制面汇总在线实例的列表，
// 账号向导据此决定是否提供“添加 BPS 授权”步骤（原生 OAuth 与导入由共用的凭据面板提供）。
var accountAuthorizations = []map[string]string{
	{"kind": "oauth"},
	{"kind": "import"},
	{"kind": "bps_oauth", "attach_to": "oauth"},
	{"kind": "bps_import", "attach_to": "oauth"},
}
