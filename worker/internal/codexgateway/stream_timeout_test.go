package codexgateway

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// RequestTimeout 只约束提交前：提交后持续有数据的长流不被总时长截断（CPR 无流总时长上限）。
func TestCommittedStreamOutlivesRequestTimeout(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		flusher := w.(http.Flusher)
		write := func(line string) {
			_, _ = io.WriteString(w, "data: "+line+"\n\n")
			flusher.Flush()
		}
		write(`{"type":"response.created","response":{"id":"resp_long"}}`)
		write(`{"type":"response.output_text.delta","delta":"a"}`)
		for i := 0; i < 3; i++ {
			time.Sleep(500 * time.Millisecond)
			write(`{"type":"response.output_text.delta","delta":"b"}`)
		}
		write(`{"type":"response.completed","response":{"id":"resp_long","usage":{"input_tokens":1,"output_tokens":1}}}`)
	}))
	t.Cleanup(upstream.Close)
	cfg := Config{DataDir: t.TempDir(), InternalToken: "secret", UpstreamBaseURL: upstream.URL, UpstreamTransport: "http", RequestTimeoutSec: 1}
	cfg.applyDefaults()
	server, err := NewServer(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := server.store.Upsert(account("a", "tok_a")); err != nil {
		t.Fatal(err)
	}
	httpServer := httptest.NewServer(server.Handler())
	t.Cleanup(httpServer.Close)
	response := signedExecute(t, cfg, httpServer.URL, Envelope{Dispatch: "d_long", RequestID: "r_long", Nonce: "n_long", Operation: "responses", Protocol: "openai.responses", Model: "gpt-test", Stream: true, Body: json.RawMessage(`{"model":"gpt-test","stream":true,"input":"hi"}`), Scope: Scope{GroupIDs: []int64{1}}})
	data, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != 200 || !strings.Contains(string(data), "response.completed") {
		t.Fatalf("long stream was cut: status=%d body=%s", response.StatusCode, data)
	}
}

func TestIdleTimeoutTransportBoundsHeadersAndSilentBodies(t *testing.T) {
	release := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/slow-headers" {
			select {
			case <-release:
			case <-r.Context().Done():
			}
			return
		}
		_, _ = io.WriteString(w, "first")
		w.(http.Flusher).Flush()
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	t.Cleanup(func() { close(release); upstream.Close() })
	client := &http.Client{Transport: &idleTimeoutTransport{base: http.DefaultTransport, header: 200 * time.Millisecond, idle: 200 * time.Millisecond}}
	if _, err := client.Get(upstream.URL + "/slow-headers"); !errors.Is(err, errUpstreamHeaderTimeout) {
		t.Fatalf("header wait must be bounded, got %v", err)
	}
	resp, err := client.Get(upstream.URL + "/silent")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if string(data) != "first" || !errors.Is(err, errUpstreamStreamIdle) {
		t.Fatalf("silent body must hit the idle timeout: data=%q err=%v", data, err)
	}
	// 调用方取消仍按原错误返回，不误报为空闲超时
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, upstream.URL+"/silent", nil)
	resp, err = client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	_, err = io.ReadAll(resp.Body)
	resp.Body.Close()
	if err == nil || errors.Is(err, errUpstreamStreamIdle) {
		t.Fatalf("caller cancel should surface as cancellation, got %v", err)
	}
}
