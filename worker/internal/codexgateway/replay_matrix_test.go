package codexgateway

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// 重放判定契约（审计阶段 2 W13）：与控制面共读 test/fixtures/executor-contract/replay-matrix.json，
// 这里锁定 Gateway Worker 的分类与重放、换号、同号重试判定；Node 侧见 test/unit/replay-matrix-contract.test.mjs。
type replayMatrixCase struct {
	ID        string            `json:"id"`
	SendState string            `json:"send_state"`
	Status    int               `json:"status"`
	Header    map[string]string `json:"header"`
	Body      string            `json:"body"`
	Gateway   *struct {
		Category         string `json:"category"`
		Replay           bool   `json:"replay"`
		Switch           bool   `json:"switch"`
		SameAccountRetry bool   `json:"same_account_retry"`
	} `json:"gateway_worker"`
}

func TestReplayMatrixMatchesTheGatewayClassifier(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "test", "fixtures", "executor-contract", "replay-matrix.json"))
	if err != nil {
		t.Fatal(err)
	}
	var matrix struct {
		Version int                `json:"version"`
		Cases   []replayMatrixCase `json:"cases"`
	}
	if err := json.Unmarshal(raw, &matrix); err != nil {
		t.Fatal(err)
	}
	if matrix.Version != 1 || len(matrix.Cases) == 0 {
		t.Fatalf("unexpected matrix version %d with %d cases", matrix.Version, len(matrix.Cases))
	}
	checked := 0
	for _, c := range matrix.Cases {
		if c.Gateway == nil {
			continue
		}
		checked++
		t.Run(c.ID, func(t *testing.T) {
			header := http.Header{}
			for key, value := range c.Header {
				header.Set(key, value)
			}
			failure := classifyHTTPFailure(c.Status, header, []byte(c.Body), time.Now())
			if string(failure.Category) != c.Gateway.Category {
				t.Fatalf("category = %s, want %s", failure.Category, c.Gateway.Category)
			}
			if got := failure.replaySafe(); got != c.Gateway.Replay {
				t.Fatalf("replay = %v, want %v", got, c.Gateway.Replay)
			}
			if got := failure.rotatesAccount(); got != c.Gateway.Switch {
				t.Fatalf("switch = %v, want %v", got, c.Gateway.Switch)
			}
			if _, got := failure.sameAccountRetryDelay(0, defaultMaxRetryAfter); got != c.Gateway.SameAccountRetry {
				t.Fatalf("same_account_retry = %v, want %v", got, c.Gateway.SameAccountRetry)
			}
		})
	}
	if checked == 0 {
		t.Fatal("no gateway cases in the matrix")
	}
}
