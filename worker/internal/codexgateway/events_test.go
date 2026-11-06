package codexgateway

import (
	"os"
	"path/filepath"
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
		if _, err := l.append(EventProbeRecorded, map[string]string{"account_id": "a"}, map[string]any{"n": i, "b": "x"}); err != nil {
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
	event, err := reopened.append(EventProbeRecorded, nil, map[string]any{"n": 5})
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
		if _, err := l.append(EventProbeRecorded, nil, map[string]any{"n": i}); err != nil {
			t.Fatal(err)
		}
	}
	_ = l.close()
	segments, _ := l.segments()
	file, _ := os.OpenFile(segments[0].path, os.O_WRONLY|os.O_APPEND, 0o600)
	_, _ = file.WriteString(`{"event_id":"evt_partial","seq":4,"type":"probe.rec`)
	_ = file.Close()
	reopened, err := openEventLog(dir, "gw-1")
	if err != nil {
		t.Fatal(err)
	}
	if reopened.head != 3 {
		t.Fatalf("head=%d", reopened.head)
	}
	event, err := reopened.append(EventProbeRecorded, nil, map[string]any{"n": 3})
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

func TestEventLogRotatesAndCleansAckedSegments(t *testing.T) {
	dir := t.TempDir()
	l, _ := openEventLog(dir, "gw-1")
	l.segBytes = 400
	clock := time.Now()
	l.now = func() time.Time { return clock }
	for i := 0; i < 12; i++ {
		if _, err := l.append(EventProbeRecorded, nil, map[string]any{"n": i, "pad": "................................"}); err != nil {
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
			_, _ = l.append(EventProbeRecorded, nil, map[string]any{"n": i})
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
	_, _ = l.append(EventProbeRecorded, nil, map[string]any{"n": 1})
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
	if _, err := l.append(EventProbeRecorded, nil, map[string]any{"n": 2}); err == nil {
		t.Skip("filesystem allowed writing into a read-only directory (running as root)")
	}
	if status := l.status(); status.Healthy {
		t.Fatalf("broken log must be unhealthy: %+v", status)
	}
	if _, err := l.append(EventProbeRecorded, nil, map[string]any{"n": 3}); err == nil {
		t.Fatal("broken log must refuse further appends")
	}
}

func TestEventLogRecoversFromBrokenStateAndLostStreamFile(t *testing.T) {
	dir := t.TempDir()
	l, _ := openEventLog(dir, "gw-1")
	_, _ = l.append(EventProbeRecorded, nil, map[string]any{"n": 1})
	stream := l.streamID
	l.mu.Lock()
	l.broken = os.ErrClosed
	l.mu.Unlock()
	l.maintain()
	if status := l.status(); !status.Healthy {
		t.Fatalf("maintain must recover a broken log: %+v", status)
	}
	if event, err := l.append(EventProbeRecorded, nil, map[string]any{"n": 2}); err != nil || event.Seq != 2 {
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
		_, _ = l.append(EventProbeRecorded, nil, map[string]any{"n": i, "pad": "................................"})
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
		_, _ = l.append(EventProbeRecorded, nil, map[string]any{"n": i})
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
	_, _ = restarted.append(EventProbeRecorded, nil, map[string]any{"n": 3})
	restarted.setRequired(false)
	restarted.maintain()
	if status := restarted.status(); status.Acked != 4 {
		t.Fatalf("known not-required policy self-acknowledges: %+v", status)
	}
}

func TestServerWithoutControlPlaneDoesNotKeepEvents(t *testing.T) {
	s, _, _ := newBPSExecuteServer(t, "http://127.0.0.1:1", bpsAccount("a", "tok_a"))
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
