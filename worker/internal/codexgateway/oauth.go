package codexgateway

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"strings"
)

// 授权（OAuth 链接、换码、账号文件与 BPS 导入）由控制面完成（2026-11-07 S1，与上游 VM 槽位相同），Worker 只从库里
// 读凭据；这里保留令牌解析与请求体读取的通用辅助函数。

func randomURLToken(size int) (string, error) {
	buf := make([]byte, size)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// jwtParsable：令牌的 payload 段可按 JWT 解析（不验签）。
func jwtParsable(token string) bool {
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return false
	}
	data, err := base64.RawURLEncoding.DecodeString(parts[1])
	var claims map[string]any
	return err == nil && json.Unmarshal(data, &claims) == nil && claims != nil
}

func jwtClaims(token string) map[string]any {
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return map[string]any{}
	}
	data, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return map[string]any{}
	}
	var claims map[string]any
	if json.Unmarshal(data, &claims) != nil || claims == nil {
		return map[string]any{}
	}
	return claims
}

func firstString(values ...any) string {
	for _, value := range values {
		if text, ok := value.(string); ok && strings.TrimSpace(text) != "" {
			return strings.TrimSpace(text)
		}
	}
	return ""
}

func stringValue(value any) string {
	if text, ok := value.(string); ok {
		return strings.TrimSpace(text)
	}
	return ""
}
func int64Number(value any) int64 {
	switch number := value.(type) {
	case float64:
		return int64(number)
	case int64:
		return number
	case int:
		return int64(number)
	}
	return -1
}
