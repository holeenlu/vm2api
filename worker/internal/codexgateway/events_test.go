package codexgateway

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestEventLogAppendReadAckAndReopen(t *testing.T) {
	dir := t.TempDir()
	l, err := openEventLog(dir, "gw-1")
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		if _, err := l.append(EventAccountQuota, map[string]string{"account_id": "a"}, map[string]any{"n": i, "b": "x"}); err != nil {
			t.Fatal(err)
		}
	}
	events, err := l.read(2, 10)
	if err != nil || len(events) != 3 || events[0].Seq != 3 || events[2].Seq != 5 {
		t.Fatalf("events=%+v err=%v", events, err)
	}
	if string(events[0].Payload) != `{"b":"x","n":2}` || events[0].validate() != nil || events[0].EventID != eventID(l.streamID, 3) {
		t.Fatalf("payload=%s event=%+v", events[0].Payload, events[0])
	}
	if err := l.ack(3); err != nil {
		t.Fatal(err)
	}
	if err := l.ack(9); err == nil {
		t.Fatal("ack beyond head must fail")
	}
	stream := l.streamID
	_ = l.close()
	reopened, err := openEventLog(dir, "gw-1")
	if err != nil {
		t.Fatal(err)
	}
	if reopened.streamID != stream || reopened.head != 5 || reopened.acked != 3 {
		t.Fatalf("reopened stream=%s head=%d acked=%d", reopened.streamID, reopened.head, reopened.acked)
	}
	event, err := reopened.append(EventAccountQuota, nil, map[string]any{"n": 5})
	if err != nil || event.Seq != 6 {
		t.Fatalf("seq=%d err=%v", event.Seq, err)
	}
	if all, _ := reopened.read(0, 100); len(all) != 6 {
		t.Fatalf("all=%d", len(all))
	}
}

func TestEventLogTruncatesCorruptTailAfterCrash(t *testing.T) {
	dir := t.TempDir()
	l, _ := openEventLog(dir, "gw-1")
	for i := 0; i < 3; i++ {
		if _, err := l.append(EventAccountQuota, nil, map[string]any{"n": i}); err != nil {
			t.Fatal(err)
		}
	}
	_ = l.close()
	segments, _ := l.segments()
	file, _ := os.OpenFile(segments[0].path, os.O_WRONLY|os.O_APPEND, 0o600)
	_, _ = file.WriteString(`{"event_id":"evt_partial","seq":4,"type":"account.quo`)
	_ = file.Close()
	reopened, err := openEventLog(dir, "gw-1")
	if err != nil {
		t.Fatal(err)
	}
	if reopened.head != 3 {
		t.Fatalf("head=%d", reopened.head)
	}
	event, err := reopened.append(EventAccountQuota, nil, map[string]any{"n": 3})
	if err != nil || event.Seq != 4 {
		t.Fatalf("seq=%d err=%v", event.Seq, err)
	}
	all, err := reopened.read(0, 100)
	if err != nil || len(all) != 4 {
		t.Fatalf("events=%d err=%v", len(all), err)
	}
	// 篡改载荷的行也视为损坏尾部
	_ = reopened.close()
	data, _ := os.ReadFile(segments[0].path)
	tampered := []byte(string(data[:len(data)-12]) + `"tampered"}` + "\n")
	_ = os.WriteFile(segments[0].path, tampered, 0o600)
	again, _ := openEventLog(dir, "gw-1")
	if again.head != 3 {
		t.Fatalf("tampered tail must be dropped, head=%d", again.head)
	}
}

// 2026-11-07 生产：一条坏记录或序号缺口不能让其后已产生的事件在重启恢复时整段丢失；
// 已确认序号超过恢复后的 head 时降到 head，控制面据此从回退点重新拉取
func TestEventLogRecoveryKeepsRecordsAfterDamageAndGaps(t *testing.T) {
	dir := t.TempDir()
	l, _ := openEventLog(dir, "gw-1")
	for i := 0; i < 5; i++ {
		if _, err := l.append(EventAccountQuota, nil, map[string]any{"n": i}); err != nil {
			t.Fatal(err)
		}
	}
	if err := l.ack(5); err != nil {
		t.Fatal(err)
	}
	_ = l.close()
	segments, _ := l.segments()
	data, _ := os.ReadFile(segments[0].path)
	lines := strings.SplitAfter(string(data), "\n")
	// 第 2 条篡改载荷（摘要不符）、第 3 条删掉（序号缺口）
	lines[1] = strings.Replace(lines[1], `"n":1`, `"n":9`, 1)
	damaged := lines[0] + lines[1] + lines[3] + lines[4]
	_ = os.WriteFile(segments[0].path, []byte(damaged), 0o600)
	reopened, err := openEventLog(dir, "gw-1")
	if err != nil {
		t.Fatal(err)
	}
	if reopened.head != 5 || reopened.acked != 5 {
		t.Fatalf("records after the damage must be kept: head=%d acked=%d", reopened.head, reopened.acked)
	}
	all, err := reopened.read(0, 100)
	if err != nil {
		t.Fatal(err)
	}
	var seqs []uint64
	for _, event := range all {
		seqs = append(seqs, event.Seq)
	}
	if fmt.Sprint(seqs) != "[1 4 5]" {
		t.Fatalf("seqs=%v", seqs)
	}
	if rewritten, _ := os.ReadFile(segments[0].path); strings.Contains(string(rewritten), `"n":9`) {
		t.Fatal("the damaged record must be removed from the segment")
	}
	if event, err := reopened.append(EventAccountQuota, nil, map[string]any{"n": 5}); err != nil || event.Seq != 6 {
		t.Fatalf("seq=%d err=%v", event.Seq, err)
	}
	_ = reopened.close()

	// 已确认 6，但最后两条丢了（恢复后 head=4）：已确认降到 4 并落盘
	data, _ = os.ReadFile(segments[0].path)
	lines = strings.SplitAfter(string(data), "\n")
	_ = os.WriteFile(segments[0].path, []byte(strings.Join(lines[:2], "")), 0o600)
	_ = os.WriteFile(filepath.Join(dir, eventAckedFileName), []byte("6\n"), 0o600)
	lowered, err := openEventLog(dir, "gw-1")
	if err != nil {
		t.Fatal(err)
	}
	if lowered.head != 4 || lowered.acked != 4 {
		t.Fatalf("head=%d acked=%d", lowered.head, lowered.acked)
	}
	if raw, _ := os.ReadFile(filepath.Join(dir, eventAckedFileName)); strings.TrimSpace(string(raw)) != "4" {
		t.Fatalf("acked file=%q", raw)
	}
}

func TestEventLogRotatesAndCleansAckedSegments(t *testing.T) {
	dir := t.TempDir()
	l, _ := openEventLog(dir, "gw-1")
	l.segBytes = 400
	clock := time.Now()
	l.now = func() time.Time { return clock }
	for i := 0; i < 12; i++ {
		if _, err := l.append(EventAccountQuota, nil, map[string]any{"n": i, "pad": "................................"}); err != nil {
			t.Fatal(err)
		}
	}
	segments, _ := l.segments()
	if len(segments) < 3 {
		t.Fatalf("expected rotation, segments=%d", len(segments))
	}
	if all, _ := l.read(0, 100); len(all) != 12 {
		t.Fatalf("read across segments=%d", len(all))
	}
	if events, _ := l.read(7, 2); len(events) != 2 || events[0].Seq != 8 {
		t.Fatalf("paged read=%+v", events)
	}
	// 确认后、保留期内不删除；过了保留期删除已确认的整段
	_ = l.ack(12)
	if after, _ := l.segments(); len(after) != len(segments) {
		t.Fatal("acked segments within retention must be kept")
	}
	old := time.Now().Add(-48 * time.Hour)
	for _, segment := range segments {
		_ = os.Chtimes(segment.path, old, old)
	}
	l.acked = 11
	_ = l.ack(12)
	after, _ := l.segments()
	if len(after) != 1 {
		t.Fatalf("expected only the active segment, got %d", len(after))
	}
	if events, _ := l.read(11, 10); len(events) != 1 || events[0].Seq != 12 {
		t.Fatalf("tail after cleanup=%+v", events)
	}
}

func TestEventLogConcurrentAppendsAreSequential(t *testing.T) {
	l, _ := openEventLog(t.TempDir(), "gw-1")
	var wg sync.WaitGroup
	for i := 0; i < 40; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, _ = l.append(EventAccountQuota, nil, map[string]any{"n": i})
		}(i)
	}
	wg.Wait()
	all, err := l.read(0, 100)
	if err != nil || len(all) != 40 {
		t.Fatalf("events=%d err=%v", len(all), err)
	}
	for i, event := range all {
		if event.Seq != uint64(i+1) {
			t.Fatalf("seq gap at %d: %d", i, event.Seq)
		}
	}
}

func TestEventLogBrokenAndBacklogStatus(t *testing.T) {
	dir := t.TempDir()
	l, _ := openEventLog(dir, "gw-1")
	if !l.status().Healthy {
		t.Fatal("fresh log must be healthy")
	}
	l.maxBacklog = 10
	_, _ = l.append(EventAccountQuota, nil, map[string]any{"n": 1})
	if status := l.status(); status.Healthy || status.BacklogBytes == 0 {
		t.Fatalf("backlog over limit must be unhealthy: %+v", status)
	}
	_ = l.ack(1)
	if status := l.status(); !status.Healthy {
		t.Fatalf("acked backlog must be healthy: %+v", status)
	}
	// 写入失败后进入故障状态
	_ = l.close()
	_ = os.Chmod(dir, 0o500)
	defer os.Chmod(dir, 0o700)
	l.segBytes = 1
	if _, err := l.append(EventAccountQuota, nil, map[string]any{"n": 2}); err == nil {
		t.Skip("filesystem allowed writing into a read-only directory (running as root)")
	}
	if status := l.status(); status.Healthy {
		t.Fatalf("broken log must be unhealthy: %+v", status)
	}
	if _, err := l.append(EventAccountQuota, nil, map[string]any{"n": 3}); err == nil {
		t.Fatal("broken log must refuse further appends")
	}
}

func TestEventLogRecoversFromBrokenStateAndLostStreamFile(t *testing.T) {
	dir := t.TempDir()
	l, _ := openEventLog(dir, "gw-1")
	_, _ = l.append(EventAccountQuota, nil, map[string]any{"n": 1})
	stream := l.streamID
	l.mu.Lock()
	l.broken = os.ErrClosed
	l.mu.Unlock()
	l.maintain()
	if status := l.status(); !status.Healthy {
		t.Fatalf("maintain must recover a broken log: %+v", status)
	}
	if event, err := l.append(EventAccountQuota, nil, map[string]any{"n": 2}); err != nil || event.Seq != 2 {
		t.Fatalf("append after recovery: seq=%d err=%v", event.Seq, err)
	}
	_ = l.close()
	// 流标识文件丢失：沿用分段里的流标识，不截掉未确认事件
	_ = os.Remove(filepath.Join(dir, eventStreamFileName))
	reopened, err := openEventLog(dir, "gw-1")
	if err != nil || reopened.streamID != stream || reopened.head != 2 {
		t.Fatalf("stream=%s want %s head=%d err=%v", reopened.streamID, stream, reopened.head, err)
	}
}

func TestEventLogIdleMaintenanceCleansOldAckedSegments(t *testing.T) {
	l, _ := openEventLog(t.TempDir(), "gw-1")
	l.segBytes = 300
	for i := 0; i < 8; i++ {
		_, _ = l.append(EventAccountQuota, nil, map[string]any{"n": i, "pad": "................................"})
	}
	_ = l.ack(8)
	segments, _ := l.segments()
	old := time.Now().Add(-48 * time.Hour)
	for _, segment := range segments {
		_ = os.Chtimes(segment.path, old, old)
	}
	// 没有新的确认序号时，维护周期也会清理已过保留期的已确认分段
	l.maintain()
	if after, _ := l.segments(); len(after) != 1 {
		t.Fatalf("expected only the active segment after idle maintenance, got %d", len(after))
	}
}

// R1 复审 N1：重启后、收到第一份心跳策略之前，不能把控制面尚未拉取的事件自行确认掉。
func TestEventLogDoesNotSelfAcknowledgeBeforeThePolicyIsKnown(t *testing.T) {
	dir := t.TempDir()
	l, _ := openEventLog(dir, "gw-1")
	for i := 0; i < 3; i++ {
		_, _ = l.append(EventAccountQuota, nil, map[string]any{"n": i})
	}
	_ = l.close()
	restarted, _ := openEventLog(dir, "gw-1")
	restarted.maxBacklog = 1
	restarted.maintain()
	if status := restarted.status(); status.Acked != 0 || status.RequiredKnown {
		t.Fatalf("unknown policy must keep unacknowledged events: %+v", status)
	}
	if !restarted.accepting() {
		t.Fatal("unknown policy must not block requests")
	}
	if events, _ := restarted.read(0, 10); len(events) != 3 {
		t.Fatalf("events before restart must stay readable, got %d", len(events))
	}
	// 心跳一直拿不到策略、未知状态超过保留期：按非必需处理，日志不无限增长
	restarted.now = func() time.Time { return time.Now().Add(eventRetention + time.Minute) }
	restarted.maintain()
	if status := restarted.status(); status.Acked != 3 || status.RequiredKnown {
		t.Fatalf("unknown policy past retention self-acknowledges: %+v", status)
	}
	restarted.now = time.Now
	_, _ = restarted.append(EventAccountQuota, nil, map[string]any{"n": 3})
	restarted.setRequired(false)
	restarted.maintain()
	if status := restarted.status(); status.Acked != 4 {
		t.Fatalf("known not-required policy self-acknowledges: %+v", status)
	}
}

func TestServerWithoutControlPlaneDoesNotKeepEvents(t *testing.T) {
	s, _, _ := newExecuteServer(t, "http://127.0.0.1:1", account("a", "tok_a"))
	if status := s.events.status(); !status.RequiredKnown || status.Required {
		t.Fatalf("a standalone Worker has no event consumer: %+v", status)
	}
	cfg := Config{DataDir: t.TempDir(), InternalToken: "secret", ControlPlaneURL: "http://127.0.0.1:1/internal/v1/gateway/workers/register"}
	cfg.applyDefaults()
	managed, err := NewServer(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if status := managed.events.status(); status.RequiredKnown {
		t.Fatalf("a managed Worker waits for the first heartbeat policy: %+v", status)
	}
}
