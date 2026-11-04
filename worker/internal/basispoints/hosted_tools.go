package basispoints

import (
	"strings"

	"github.com/tidwall/gjson"
)

// DeclaresHostedTools reports whether the request declares hosted tools that the
// bridge ignores in automatic mode (see isUnsupportedHostedTool). vm2api local
// adaptation: the gateway uses it to honor the per-account "omit unsupported
// tools" switch before choosing the BPS route.
func DeclaresHostedTools(body []byte) bool {
	found := false
	gjson.GetBytes(body, "tools").ForEach(func(_, tool gjson.Result) bool {
		if isUnsupportedHostedTool(strings.ToLower(strings.TrimSpace(tool.Get("type").String()))) {
			found = true
			return false
		}
		return true
	})
	return found
}
