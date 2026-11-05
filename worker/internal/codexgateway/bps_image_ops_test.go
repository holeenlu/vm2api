package codexgateway

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
)

func runImageOp(t *testing.T, cfg Config, baseURL, operation, body string) (*http.Response, []byte) {
	t.Helper()
	n := nonceSeq.Add(1)
	response := signedExecute(t, cfg, baseURL, Envelope{Dispatch: fmt.Sprintf("d_%d", n), RequestID: fmt.Sprintf("r_%d", n), Nonce: fmt.Sprintf("n_%d", n), Operation: operation, Protocol: "openai.images", Model: "gpt-image-2", Body: json.RawMessage(body), Scope: Scope{GroupIDs: []int64{1}}, Scheduling: bpsOn})
	data, _ := io.ReadAll(response.Body)
	response.Body.Close()
	return response, data
}

const imageResult = `{"created":1,"data":[{"b64_json":"aW1n"}],"usage":{"input_tokens":5,"output_tokens":10,"total_tokens":15}}`

func TestBPSImageGenerationsUseTheBPSImagesEndpoint(t *testing.T) {
	upstream, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){"bps_tok_a": {jsonReply(200, imageResult)}, "tok_a": {jsonReply(200, imageResult)}})
	_, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a", "gpt-image-2"))
	response, body := runImageOp(t, cfg, httpServer.URL, "images.generations", `{"model":"gpt-image-2","prompt":"a cat","size":"1024x1024","moderation":"auto"}`)
	if response.StatusCode != 200 || !strings.Contains(string(body), "aW1n") || response.Header.Get(authModeHeader) != "bps" || !strings.HasSuffix(response.Header.Get(upstreamPathHeader), "/images/generations") {
		t.Fatalf("status=%d mode=%q body=%s", response.StatusCode, response.Header.Get(authModeHeader), body)
	}
	header := upstream.headers["bps_tok_a"]
	if upstream.paths[0] != "/bps/images/generations" || header.Get("X-Openai-Internal-Basispoints-Office-Host") != "Excel" || strings.Contains(string(upstream.bodies["bps_tok_a"]), "moderation") {
		t.Fatalf("paths=%v body=%s", upstream.paths, upstream.bodies["bps_tok_a"])
	}
	if upstream.count("tok_a") != 0 {
		t.Fatal("native must not be called")
	}
}

func TestBPSImageFormatRejectionFallsBackToNative(t *testing.T) {
	upstream, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){"bps_tok_a": {jsonReply(422, `{"error":{"type":"invalid_request_error","message":"bad field size"}}`)}, "tok_a": {jsonReply(200, imageResult)}})
	_, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a", "gpt-image-2"))
	response, body := runImageOp(t, cfg, httpServer.URL, "images.generations", `{"model":"gpt-image-2","prompt":"a cat","size":"7x7"}`)
	if response.StatusCode != 200 || upstream.count("tok_a") != 1 || upstream.count("bps_tok_a") != 1 {
		t.Fatalf("status=%d bps=%d native=%d body=%s", response.StatusCode, upstream.count("bps_tok_a"), upstream.count("tok_a"), body)
	}
	if attempts := attemptsOf(t, response); attempts[0].Category != "bps_unsupported" || attempts[0].SendState != sendStateSent || attempts[0].Stage != "images_endpoint" {
		t.Fatalf("attempts=%s", response.Header.Get(attemptsHeader))
	}
}

func TestBPSImageEditsAreSentAsMultipart(t *testing.T) {
	upstream, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){"bps_tok_a": {jsonReply(200, imageResult)}})
	_, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a", "gpt-image-2"))
	response, body := runImageOp(t, cfg, httpServer.URL, "images.edits", `{"model":"gpt-image-2","prompt":"hat","images":[{"image_url":"data:image/png;base64,`+bpsTestPNG+`"}]}`)
	if response.StatusCode != 200 || !strings.HasSuffix(response.Header.Get(upstreamPathHeader), "/images/edits") {
		t.Fatalf("status=%d body=%s", response.StatusCode, body)
	}
	header, sent := upstream.headers["bps_tok_a"], string(upstream.bodies["bps_tok_a"])
	if upstream.paths[0] != "/bps/images/edits" || !strings.HasPrefix(header.Get("Content-Type"), "multipart/form-data") || !strings.Contains(sent, `name="image"`) || !strings.Contains(sent, "Content-Type: image/png") || !strings.Contains(sent, "hat") {
		t.Fatalf("content-type=%s body=%q", header.Get("Content-Type"), sent)
	}
}

func TestBPSImageRequestsBPSCannotCarryStayNative(t *testing.T) {
	for name, c := range map[string]struct{ op, body string }{
		"stream":       {"images.generations", `{"model":"gpt-image-2","prompt":"x","stream":true}`},
		"webp":         {"images.generations", `{"model":"gpt-image-2","prompt":"x","output_format":"webp"}`},
		"transparent":  {"images.generations", `{"model":"gpt-image-2","prompt":"x","background":"transparent"}`},
		"mask":         {"images.edits", `{"model":"gpt-image-2","prompt":"x","images":[{"image_url":"data:image/png;base64,` + bpsTestPNG + `"}],"mask":{"image_url":"data:image/png;base64,` + bpsTestPNG + `"}}`},
		"two images":   {"images.edits", `{"model":"gpt-image-2","prompt":"x","images":[{"image_url":"data:image/png;base64,` + bpsTestPNG + `"},{"image_url":"data:image/png;base64,` + bpsTestPNG + `"}]}`},
		"remote image": {"images.edits", `{"model":"gpt-image-2","prompt":"x","images":[{"image_url":"https://example.com/a.png"}]}`},
	} {
		if request := inspectBPSImagesRequest(Envelope{Operation: c.op, Model: "gpt-image-2"}, []byte(c.body)); request.Supported {
			t.Fatalf("%s must stay native", name)
		}
	}
	if request := inspectBPSImagesRequest(Envelope{Operation: "images.generations", Model: "gpt-image-1"}, []byte(`{"prompt":"x"}`)); request.Supported {
		t.Fatal("unlisted image models stay native")
	}
}
