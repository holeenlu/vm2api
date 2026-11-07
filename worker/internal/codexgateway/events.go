package codexgateway

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// 事件发件箱（执行契约 v1，设计 5.6）：事件先追加到数据目录 events/ 下的分段日志并 fsync，才算产生；
// 控制面按序号拉取、确认后清理。日志有稳定的 stream_id（首次创建时生成）：数据目录重建即换一条新流，
// 控制面按（实例, stream_id）维护游标。
//
// 是否“必需”由控制面在心跳响应中下发（executor_events.required；2026-11-07 S2 起事件是唯一结算通道，控制面恒下发为真）：
//   - 必需：不自行确认；executor_events.enforce 为真时，写入失败或未确认积压超限 Worker 停止接新请求
//     （结果无法可靠交给控制面）；
//   - 非必需（旧版控制面不下发也算）：Worker 自行确认到最新序号，日志只保留 24 小时供排障，不逐条 fsync，写入故障不影响接单；
//   - 未知（进程启动后、收到第一份心跳策略之前）：既不自行确认（控制面可能还没拉取重启前的事件），也不因事件拒单。
//     不接控制面（未配置 KIN_CODEX_GATEWAY_CONTROL_PLANE_URL）的 Worker 启动即为非必需。
//     未知状态持续超过保留期（心跳一直拿不到策略）时按非必需处理，避免日志无限增长（R1 第二轮复审 P2-a）。
//
// 写入故障在维护周期内自动尝试恢复（截掉残缺尾部、重开文件）。
const (
	eventSegmentBytes   = 4 << 20
	eventRetention      = 24 * time.Hour
	eventMaxBacklog     = 512 << 20
	eventReadLimitMax   = 1000
	eventSegmentPrefix  = "seg-"
	eventSegmentSuffix  = ".log"
	eventStreamFileName = "stream_id"
	eventAckedFileName  = "acked"
)

var errEventLogUnavailable = errors.New("executor event log is unavailable")

const (
	requiredUnknown int32 = iota
	requiredNo
	requiredYes
)

type eventSegment struct {
	first uint64
	path  string
	size  int64
	mod   time.Time
}

type eventLog struct {
	// required：控制面是否消费事件（见文件头注释）：requiredUnknown / requiredNo / requiredYes
	required atomic.Int32
	// enforce：必需时，日志写入失败或积压超限是否拒单（终审 A5）
	enforce atomic.Bool
	// resnapshot：控制面刚开始消费事件（必需转为“是”）；下一轮快照无论有无变化都发一份完整账号终态，
	// 补上切换窗口内被自行确认掉的状态变化（终审 A10）
	resnapshot atomic.Bool
	mu         sync.Mutex
	// unacked 是未确认积压的字节数（启动与确认时按分段重算，追加时累加），供每个请求快速判断能否接单
	unacked    int64
	dir        string
	streamID   string
	instanceID string
	head       uint64
	acked      uint64
	file       *os.File
	fileFirst  uint64
	fileSize   int64
	broken     error
	now        func() time.Time
	// opened：日志打开时刻；required 一直未知超过保留期时按非必需处理
	opened     time.Time
	retention  time.Duration
	maxBacklog int64
	segBytes   int64
}

func openEventLog(dir, instanceID string) (*eventLog, error) {
	l := &eventLog{dir: dir, instanceID: instanceID, now: time.Now, opened: time.Now(), retention: eventRetention, maxBacklog: eventMaxBacklog, segBytes: eventSegmentBytes}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	stream, err := os.ReadFile(filepath.Join(dir, eventStreamFileName))
	switch {
	case err == nil && validStreamID(strings.TrimSpace(string(stream))):
		l.streamID = strings.TrimSpace(string(stream))
	case err == nil || os.IsNotExist(err):
		// 流标识文件丢失或损坏时，优先沿用已有分段里的流标识，避免把未确认事件当成另一条流截掉
		if recovered := l.streamFromSegments(); recovered != "" {
			l.streamID = recovered
		} else {
			token, tokenErr := randomURLToken(12)
			if tokenErr != nil {
				return nil, tokenErr
			}
			l.streamID = strings.NewReplacer("-", "", "_", "").Replace(token)
		}
		if err := writeFileSynced(filepath.Join(dir, eventStreamFileName), []byte(l.streamID+"\n")); err != nil {
			return nil, err
		}
	default:
		return nil, err
	}
	if raw, err := os.ReadFile(filepath.Join(dir, eventAckedFileName)); err == nil {
		l.acked, _ = strconv.ParseUint(strings.TrimSpace(string(raw)), 10, 64)
	}
	if err := l.recover(); err != nil {
		return nil, err
	}
	l.unacked = l.backlogLocked()
	return l, nil
}

// backlogLocked 按分段统计未确认积压（含已确认序号所在的整段）。
func (l *eventLog) backlogLocked() int64 {
	segments, err := l.segments()
	if err != nil {
		return 0
	}
	var total int64
	for i, segment := range segments {
		lastSeq := l.head
		if i+1 < len(segments) {
			lastSeq = segments[i+1].first - 1
		}
		if lastSeq > l.acked {
			total += segment.size
		}
	}
	return total
}

// accepting：控制面不消费事件时始终接单；消费时只有日志可写且积压未超限才接新请求。
func (l *eventLog) accepting() bool {
	if l == nil || l.required.Load() != requiredYes || !l.enforce.Load() {
		return true
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.broken == nil && l.unacked <= l.maxBacklog
}

func (l *eventLog) setRequired(required bool) {
	l.setPolicy(required, required)
}

// takeResnapshot 返回并清除“需要发完整快照”标记。
func (l *eventLog) takeResnapshot() bool {
	return l != nil && l.resnapshot.Swap(false)
}

// setPolicy：required 决定是否等控制面确认（不自行确认）；enforce 决定日志故障时是否拒单。
func (l *eventLog) setPolicy(required, enforce bool) {
	if l == nil {
		return
	}
	l.enforce.Store(required && enforce)
	if required {
		if l.required.Swap(requiredYes) != requiredYes {
			l.resnapshot.Store(true)
		}
	} else {
		l.required.Store(requiredNo)
	}
}

// maintain 在维护周期调用：故障时尝试恢复；控制面不消费时自行确认到最新序号；清理过期分段。
func (l *eventLog) maintain() {
	if l == nil {
		return
	}
	l.mu.Lock()
	if l.broken != nil {
		if l.file != nil {
			_ = l.file.Close()
			l.file = nil
		}
		if err := l.recover(); err == nil {
			l.broken = nil
		}
	}
	head := l.head
	required := l.required.Load()
	if required == requiredUnknown && l.now().Sub(l.opened) > l.retention {
		required = requiredNo
	}
	l.mu.Unlock()
	if required == requiredNo && head > 0 {
		_ = l.ack(head)
	}
	l.mu.Lock()
	_ = l.cleanupLocked()
	l.unacked = l.backlogLocked()
	l.mu.Unlock()
}

func validStreamID(value string) bool {
	if value == "" || len(value) > 64 {
		return false
	}
	for _, r := range value {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9') {
			return false
		}
	}
	return true
}

// streamFromSegments 读取任一分段第一条完整事件的流标识。
func (l *eventLog) streamFromSegments() string {
	segments, err := l.segments()
	if err != nil {
		return ""
	}
	for i := len(segments) - 1; i >= 0; i-- {
		file, err := os.Open(segments[i].path)
		if err != nil {
			continue
		}
		line, _ := bufio.NewReader(file).ReadBytes('\n')
		_ = file.Close()
		var event executorEvent
		if json.Unmarshal(line, &event) == nil && validStreamID(event.StreamID) {
			return event.StreamID
		}
	}
	return ""
}

// syncDir 让新建与改名的目录项落盘（掉电后不丢失刚创建的分段）。
func syncDir(dir string) {
	if handle, err := os.Open(dir); err == nil {
		_ = handle.Sync()
		_ = handle.Close()
	}
}

func writeFileSynced(path string, data []byte) error {
	tmp := path + ".tmp"
	file, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err = file.Write(data); err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(tmp, path)
	}
	if err != nil {
		_ = os.Remove(tmp)
		return err
	}
	syncDir(filepath.Dir(path))
	return nil
}

func (l *eventLog) segments() ([]eventSegment, error) {
	entries, err := os.ReadDir(l.dir)
	if err != nil {
		return nil, err
	}
	var out []eventSegment
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasPrefix(name, eventSegmentPrefix) || !strings.HasSuffix(name, eventSegmentSuffix) {
			continue
		}
		first, err := strconv.ParseUint(strings.TrimSuffix(strings.TrimPrefix(name, eventSegmentPrefix), eventSegmentSuffix), 10, 64)
		if err != nil || first == 0 {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			return nil, err
		}
		out = append(out, eventSegment{first: first, path: filepath.Join(l.dir, name), size: info.Size(), mod: info.ModTime()})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].first < out[j].first })
	return out, nil
}

func segmentName(first uint64) string {
	return fmt.Sprintf("%s%020d%s", eventSegmentPrefix, first, eventSegmentSuffix)
}

// recover 校验最后一段：截掉崩溃留下的残缺或损坏的尾部，恢复 head。
func (l *eventLog) recover() error {
	segments, err := l.segments()
	if err != nil {
		return err
	}
	l.head = l.acked
	if len(segments) == 0 {
		return nil
	}
	last := segments[len(segments)-1]
	file, err := os.OpenFile(last.path, os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer file.Close()
	reader := bufio.NewReader(file)
	expected := last.first
	var good int64
	for {
		line, readErr := reader.ReadBytes('\n')
		if len(line) > 0 && line[len(line)-1] == '\n' {
			var event executorEvent
			if json.Unmarshal(line, &event) != nil || event.Seq != expected || event.StreamID != l.streamID || event.validate() != nil {
				break
			}
			good += int64(len(line))
			expected++
		}
		if readErr != nil {
			break
		}
	}
	if good < last.size {
		if err := file.Truncate(good); err != nil {
			return err
		}
		if err := file.Sync(); err != nil {
			return err
		}
	}
	if expected > last.first {
		l.head = expected - 1
	} else if last.first > 1 {
		l.head = max(l.head, last.first-1)
	}
	return nil
}

// append 追加一条事件并 fsync；返回后事件即为已产生。
func (l *eventLog) append(kind string, subject map[string]string, payload any) (executorEvent, error) {
	if l == nil {
		return executorEvent{}, errEventLogUnavailable
	}
	raw, sum, err := canonicalPayload(payload)
	if err != nil {
		return executorEvent{}, err
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.broken != nil {
		return executorEvent{}, errEventLogUnavailable
	}
	seq := l.head + 1
	event := executorEvent{EventID: eventID(l.streamID, seq), StreamID: l.streamID, InstanceID: l.instanceID, Seq: seq, Type: kind, Version: executorContractVersion, OccurredAt: l.now().UTC().Format(time.RFC3339Nano), Subject: subject, Payload: raw, PayloadSHA256: sum}
	if err := event.validate(); err != nil {
		return executorEvent{}, err
	}
	line, err := marshalJSON(event)
	if err != nil {
		return executorEvent{}, err
	}
	line = append(line, '\n')
	if err := l.writeLocked(seq, line); err != nil {
		l.broken = err
		return executorEvent{}, fmt.Errorf("%w: %v", errEventLogUnavailable, err)
	}
	l.head = seq
	l.unacked += int64(len(line))
	return event, nil
}

func (l *eventLog) writeLocked(seq uint64, line []byte) error {
	if l.file == nil || l.fileSize+int64(len(line)) > l.segBytes {
		if l.file != nil {
			if err := l.file.Close(); err != nil {
				return err
			}
			l.file = nil
		}
		first := seq
		// 重启后继续写最后一段（未满时），否则新开一段
		if segments, err := l.segments(); err == nil && len(segments) > 0 {
			last := segments[len(segments)-1]
			if last.size+int64(len(line)) <= l.segBytes && last.first <= seq {
				first = last.first
			}
		}
		file, err := os.OpenFile(filepath.Join(l.dir, segmentName(first)), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		if err != nil {
			return err
		}
		syncDir(l.dir)
		info, err := file.Stat()
		if err != nil {
			_ = file.Close()
			return err
		}
		l.file, l.fileFirst, l.fileSize = file, first, info.Size()
	}
	if _, err := l.file.Write(line); err != nil {
		return err
	}
	// 控制面明确不消费事件时不逐条 fsync：日志只供排障，避免默认关闭时每个请求收尾都在全局锁内等磁盘（终审 A6）。
	// 必需或尚未知道（重启后、首个心跳策略前）时照常 fsync，事件落盘才算产生
	if l.required.Load() != requiredNo {
		if err := l.file.Sync(); err != nil {
			return err
		}
	}
	l.fileSize += int64(len(line))
	return nil
}

// read 返回序号大于 after 的事件，最多 limit 条。
func (l *eventLog) read(after uint64, limit int) ([]executorEvent, error) {
	if limit <= 0 || limit > eventReadLimitMax {
		limit = eventReadLimitMax
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	segments, err := l.segments()
	if err != nil {
		return nil, err
	}
	events := []executorEvent{}
	for i, segment := range segments {
		if i+1 < len(segments) && segments[i+1].first <= after+1 {
			continue
		}
		file, err := os.Open(segment.path)
		if err != nil {
			return nil, err
		}
		scanner := bufio.NewScanner(file)
		scanner.Buffer(make([]byte, 64<<10), 64<<20)
		for scanner.Scan() {
			var event executorEvent
			if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
				_ = file.Close()
				return nil, err
			}
			if event.Seq <= after {
				continue
			}
			events = append(events, event)
			if len(events) >= limit {
				_ = file.Close()
				return events, nil
			}
		}
		scanErr := scanner.Err()
		_ = file.Close()
		if scanErr != nil {
			return nil, scanErr
		}
	}
	return events, nil
}

// ack 记录控制面已处理到的序号，并清理已确认且超过保留期的分段。
func (l *eventLog) ack(seq uint64) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if seq > l.head {
		return fmt.Errorf("ack %d is beyond head %d", seq, l.head)
	}
	if seq <= l.acked {
		return nil
	}
	if err := writeFileSynced(filepath.Join(l.dir, eventAckedFileName), []byte(strconv.FormatUint(seq, 10)+"\n")); err != nil {
		return err
	}
	l.acked = seq
	err := l.cleanupLocked()
	l.unacked = l.backlogLocked()
	return err
}

func (l *eventLog) cleanupLocked() error {
	segments, err := l.segments()
	if err != nil {
		return err
	}
	cutoff := l.now().Add(-l.retention)
	for i := 0; i+1 < len(segments); i++ {
		segment := segments[i]
		lastSeq := segments[i+1].first - 1
		if lastSeq <= l.acked && segment.mod.Before(cutoff) && segment.first != l.fileFirst {
			if err := os.Remove(segment.path); err != nil && !os.IsNotExist(err) {
				return err
			}
		}
	}
	return nil
}

type eventLogStatus struct {
	StreamID      string `json:"stream_id"`
	Required      bool   `json:"required"`
	RequiredKnown bool   `json:"required_known"`
	Head          uint64 `json:"head"`
	Acked         uint64 `json:"acked"`
	BacklogBytes  int64  `json:"backlog_bytes"`
	Healthy       bool   `json:"healthy"`
	Error         string `json:"error,omitempty"`
}

// status 汇报水位；未确认积压超过上限或写入故障时不健康（Worker 停止接新请求）。
func (l *eventLog) status() eventLogStatus {
	if l == nil {
		return eventLogStatus{Error: errEventLogUnavailable.Error()}
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	required := l.required.Load()
	status := eventLogStatus{StreamID: l.streamID, Required: required == requiredYes, RequiredKnown: required != requiredUnknown, Head: l.head, Acked: l.acked, BacklogBytes: l.unacked, Healthy: true}
	if l.broken != nil {
		status.Healthy, status.Error = false, l.broken.Error()
	} else if status.BacklogBytes > l.maxBacklog {
		status.Healthy, status.Error = false, "event backlog exceeds limit"
	}
	return status
}

func (l *eventLog) close() error {
	if l == nil {
		return nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.file == nil {
		return nil
	}
	err := l.file.Close()
	l.file = nil
	return err
}
