/**
 * 执行事件接收器（执行契约 5.6；docs/control-plane/DEVELOPMENT_PLAN.md P1.6–P1.8、P2.3）。
 *
 * 按（实例, 事件流）游标从 Worker 拉取事件，校验后按事件 ID 去重写入 executor_event_inbox，再按 KIN_EXECUTOR_EVENTS：
 *   - off：不拉取。Worker 从心跳策略得知控制面不消费，自行确认、不因事件积压拒单。
 *   - shadow：不生效，只与旧通道比对：request.finalized 的载荷按控制面口径重算摘要并与回执表比较，probe.recorded 与探测记录比较；
 *     account.state / account.quota 是整体快照，与心跳到达时间不同步，只记录（正确性由 primary 测试覆盖）。
 *   - primary：以事件为主来源，调用与旧通道相同的写入函数；request.finalized 入库 60 秒后补齐请求尝试（统一结果写入器）。
 *     心跳中的同类字段只在事件链路健康时停写（gateway-routes.mjs eventsChannelHealthy）。
 *
 * 游标从 max(本地游标, Worker 已确认序号) 开始：Worker 在控制面不消费期间已自行确认的事件不再重放（它们由回执与心跳兜底）。
 * 处理异常的事件不推进游标，下一轮重试；信封无效的事件记为 invalid 并跳过（回执重放与下一次快照兜底），同时告警。
 */
import { withTransaction } from '../db/database.mjs'
import { executorEventsMode, executorPayloadHash, validateExecutorEvent } from './contract.mjs'
import { applyFinalizedAttempts } from './result-writer.mjs'
import { flushWrites } from '../db/write-behind.mjs'

const PAGE_LIMIT = 200
const MAX_PAGES_PER_TICK = 10
const PENDING_TIMEOUT_MS = 10 * 60_000
const INBOX_RETENTION_MS = 7 * 24 * 3600_000
const ATTEMPTS_DELAY_MS = 60_000
const BACKLOG_WARN_BYTES = 256 << 20
const WARN_INTERVAL_MS = 5 * 60_000
const RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000]

// attempts_state 的重试状态 retry:<次数>:<下次时间毫秒>
function parseRetry(state) {
  const match = /^retry:(\d+)(?::(\d+))?$/.exec(String(state || ''))
  return { tries: Number(match?.[1] || 0), nextAt: Number(match?.[2] || 0) }
}
const DONE = new Set(['recorded', 'matched', 'diff', 'pending', 'missing', 'applied', 'stale', 'invalid'])

export function createExecutorEventIngest({
  db,
  repo,
  client,
  mode = null,
  onAccountState = null,
  attemptsRepo = null,
  now = () => Date.now(),
  log = console,
}) {
  const stamp = () => new Date(now()).toISOString()
  const currentMode = () => mode || executorEventsMode()
  // 告警限频（R1 复审 N3）：同一类告警 5 分钟内只输出一次
  const warnedAt = new Map()
  function warn(key, message) {
    const last = warnedAt.get(key) || 0
    if (now() - last < WARN_INTERVAL_MS) return
    warnedAt.set(key, now())
    log.warn?.(message)
  }

  function cursorOf(instanceId) {
    return db
      .prepare(
        'SELECT stream_id,last_seq FROM executor_event_cursors WHERE instance_id=? ORDER BY updated_at DESC,rowid DESC LIMIT 1',
      )
      .get(instanceId)
  }

  // 每次成功拉取都刷新 updated_at：心跳据此判断事件链路是否在工作
  function saveCursor(instanceId, streamId, seq) {
    db.prepare(
      `INSERT INTO executor_event_cursors(instance_id,stream_id,last_seq,updated_at) VALUES(?,?,?,?)
       ON CONFLICT(instance_id,stream_id) DO UPDATE SET last_seq=MAX(last_seq,excluded.last_seq),updated_at=excluded.updated_at`,
    ).run(instanceId, streamId, seq, stamp())
  }

  function writeInbox(event, activeMode, status, detail = null, raw = null) {
    db.prepare(
      `INSERT INTO executor_event_inbox(event_id,instance_id,stream_id,seq,type,occurred_at,subject_json,payload_json,mode,status,detail,received_at,checked_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(event_id) DO UPDATE SET mode=excluded.mode,status=excluded.status,detail=excluded.detail,checked_at=excluded.checked_at`,
    ).run(
      String(event.event_id),
      String(event.instance_id),
      String(event.stream_id),
      Number(event.seq) || 0,
      String(event.type || 'unknown'),
      String(event.occurred_at || stamp()),
      event.subject && typeof event.subject === 'object' ? JSON.stringify(event.subject) : null,
      JSON.stringify(raw ?? event.payload ?? null),
      activeMode,
      status,
      detail ? String(detail).slice(0, 1000) : null,
      stamp(),
      stamp(),
    )
  }

  // 影子比对：request.finalized 与回执表（按控制面口径重算载荷摘要），probe.recorded 与探测记录
  function compare(event) {
    const payload = event.payload || {}
    if (event.type === 'request.finalized') {
      const receipt = db
        .prepare('SELECT payload_hash FROM gateway_worker_receipts WHERE gateway_instance_id=? AND dispatch_id=?')
        .get(event.instance_id, payload.dispatch_id)
      if (!receipt) return { status: 'pending' }
      const { payload_hash: claimed, ...unsigned } = payload
      const recomputed = executorPayloadHash(unsigned)
      if (recomputed !== claimed)
        return { status: 'diff', detail: `event payload hash ${claimed} != recomputed ${recomputed}` }
      return receipt.payload_hash === recomputed
        ? { status: 'matched' }
        : { status: 'diff', detail: `receipt payload_hash ${receipt.payload_hash} != event ${recomputed}` }
    }
    if (event.type === 'probe.recorded') {
      const binding = repo.findAccountByRuntime(event.instance_id, String(payload.account_id || ''))
      if (!binding) return { status: 'diff', detail: 'probe account has no binding' }
      // 探测记录入库时截成毫秒精度（recordBpsProbes），比对按同样口径（R1 审查 P1-1）
      const probedAt = Date.parse(String(payload.probed_at || ''))
      if (!Number.isFinite(probedAt)) return { status: 'diff', detail: 'invalid probed_at' }
      const probe = db
        .prepare(
          'SELECT ok,total_tokens FROM gateway_bps_probes WHERE gateway_instance_id=? AND account_resource_id=? AND probed_at=?',
        )
        .get(event.instance_id, binding.account_resource_id, new Date(probedAt).toISOString())
      if (!probe) return { status: 'pending' }
      return Boolean(probe.ok) === Boolean(payload.ok) &&
        Number(probe.total_tokens || 0) === Number(payload.total_tokens || 0)
        ? { status: 'matched' }
        : { status: 'diff', detail: 'probe record differs' }
    }
    return { status: 'recorded' }
  }

  // 主来源：调用与旧通道相同的写入函数
  function apply(event) {
    const payload = event.payload || {}
    switch (event.type) {
      case 'request.finalized': {
        if (payload.gateway_instance_id !== event.instance_id)
          return { status: 'diff', detail: 'receipt instance mismatch' }
        const ingested = repo.ingestReceipt(payload)
        if (ingested.rejected) return { status: 'diff', detail: ingested.code || 'receipt_rejected' }
        // 回执已由事件入库：让 Worker 清理旧回执目录（不等待，失败由回执重放兜底）
        void Promise.resolve()
          .then(() => client.ackReceipt(event.instance_id, payload.dispatch_id, ingested.receipt_id || null))
          .catch(() => {})
        return { status: 'applied', detail: ingested.duplicate ? 'duplicate' : null }
      }
      case 'account.state': {
        // 整体快照：只应用不早于已应用快照的事件，避免追赶旧事件时把账号终态写回旧值（R1 审查 P1-4）
        const latest = db
          .prepare(
            "SELECT MAX(occurred_at) AS at FROM executor_event_inbox WHERE instance_id=? AND type='account.state' AND status='applied'",
          )
          .get(event.instance_id)?.at
        if (latest && Date.parse(event.occurred_at) < Date.parse(latest)) return { status: 'stale' }
        repo.recordRuntimeCredentials(event.instance_id, Array.isArray(payload.items) ? payload.items : [])
        onAccountState?.()
        return { status: 'applied' }
      }
      case 'account.quota':
        // recordRuntimeQuotas 自带“已有更新快照时跳过”
        repo.recordRuntimeQuotas(event.instance_id, Array.isArray(payload.items) ? payload.items : [])
        return { status: 'applied' }
      case 'probe.recorded':
        repo.recordBpsProbes(event.instance_id, [payload])
        return { status: 'applied' }
      default:
        return { status: 'diff', detail: `unhandled type ${event.type}` }
    }
  }

  function handle(event, activeMode) {
    const existing = db.prepare('SELECT status,mode FROM executor_event_inbox WHERE event_id=?').get(event.event_id)
    if (existing && DONE.has(existing.status) && (existing.mode === activeMode || activeMode === 'shadow'))
      return { status: existing.status, duplicate: true }
    const result = activeMode === 'primary' ? apply(event) : compare(event)
    writeInbox(event, activeMode, result.status, result.detail)
    return result
  }

  async function pullInstance(instance, activeMode, summary) {
    const cursor = cursorOf(instance.id)
    let streamId = cursor?.stream_id || ''
    let after = Number(cursor?.last_seq || 0)
    for (let page = 0; page < MAX_PAGES_PER_TICK; page++) {
      let response
      try {
        response = await client.readEvents(instance.id, { after, streamId, limit: PAGE_LIMIT })
      } catch {
        summary.failed++
        return
      }
      if (response?.status === 409 && response.data?.stream_id) {
        // Worker 数据目录重建：换到新流
        streamId = String(response.data.stream_id)
        after = 0
        summary.streams++
        continue
      }
      if (!response?.ok) {
        summary.failed++
        return
      }
      streamId ||= String(response.data?.stream_id || '')
      if (!streamId) return
      // Worker 已确认（含控制面不消费期间自行确认）的事件不再处理
      const floor = Math.max(after, Number(response.data?.acked || 0))
      let processed = floor
      let stuck = false
      const events = Array.isArray(response.data?.events) ? response.data.events : []
      for (const event of events) {
        if (!(Number(event?.seq) > processed)) continue
        const valid = validateExecutorEvent(event, { instanceId: instance.id, streamId })
        if (!valid.ok) {
          // 信封无效：记录并跳过，不阻塞整条流（回执重放与下一次快照兜底），同时告警
          summary.invalid++
          const seq = Number(event?.seq)
          writeInbox(
            {
              event_id: String(event?.event_id || `invalid_${instance.id}_${streamId}_${seq}`),
              instance_id: instance.id,
              stream_id: streamId,
              seq,
              type: event?.type,
              occurred_at: event?.occurred_at,
            },
            activeMode,
            'invalid',
            valid.code,
            event ?? null,
          )
          warn(
            `invalid:${instance.id}`,
            `executor events: invalid event ${event?.event_id || seq} from ${instance.id}: ${valid.code}`,
          )
          processed = seq
          saveCursor(instance.id, streamId, processed)
          continue
        }
        if (event.seq !== processed + 1) summary.gaps++
        let result
        try {
          result = handle(event, activeMode)
        } catch (error) {
          writeInbox(event, activeMode, 'failed', error?.message || error)
          summary.failed++
          stuck = true
          warn(`failed:${instance.id}`, `executor events: ${event.event_id} failed: ${error?.message || error}`)
          break
        }
        const key = result.duplicate ? 'duplicate' : result.status
        summary[key] = (summary[key] || 0) + 1
        processed = event.seq
        saveCursor(instance.id, streamId, processed)
      }
      // 没有新事件也刷新游标时间：表示事件链路在工作；卡在失败事件上时不刷新，让心跳兜底（R1 复审 N2）
      if (!stuck) saveCursor(instance.id, streamId, processed)
      if (processed > Number(response.data?.acked || 0)) {
        try {
          await client.ackEvents(instance.id, streamId, processed)
        } catch {}
      }
      if (stuck || processed === after || events.length < PAGE_LIMIT) return
      after = processed
    }
  }

  // 影子模式下回执可能晚于事件到达：到期仍找不到旧通道记录的标记为 missing（也是差异）
  function recheckPending() {
    const rows = db
      .prepare("SELECT * FROM executor_event_inbox WHERE status='pending' ORDER BY received_at LIMIT 500")
      .all()
    for (const row of rows) {
      const event = { ...row, subject: null, payload: JSON.parse(row.payload_json) }
      const result = compare(event)
      if (result.status === 'pending' && now() - Date.parse(row.received_at) > PENDING_TIMEOUT_MS)
        result.status = 'missing'
      if (result.status !== 'pending')
        db.prepare('UPDATE executor_event_inbox SET status=?,detail=?,checked_at=? WHERE event_id=?').run(
          result.status,
          result.detail || null,
          stamp(),
          row.event_id,
        )
    }
  }

  // 主来源模式：request.finalized 入库 60 秒后（实时写入已完成）按事件补齐请求尝试（P2.3）。
  // 先提交写回队列；整批放进一个事务、每行一个保存点；失败行按 1、5、15 分钟退避重试 3 次，之后记为 failed
  // （R2 P2-2、P2-3，R2 复审 N1、N3、N4）。两条查询与迁移 104 的部分索引条件逐字一致，并以 INDEXED BY 指定。
  function completeAttempts() {
    if (!attemptsRepo) return { processed: 0 }
    const todo = db
      .prepare(
        `SELECT event_id,payload_json,attempts_state FROM executor_event_inbox INDEXED BY idx_executor_inbox_attempts_todo
         WHERE attempts_state IS NULL AND type = 'request.finalized' AND mode = 'primary' AND status = 'applied'
           AND received_at < ?
         ORDER BY received_at LIMIT 200`,
      )
      .all(new Date(now() - ATTEMPTS_DELAY_MS).toISOString())
    // 先只取状态列，按到期时间在 JS 里筛出已到期的再取载荷：退避中的行再多也不会挡住已到期的行（R2 第二轮复审 N8）
    const due = db
      .prepare(
        `SELECT event_id,attempts_state FROM executor_event_inbox INDEXED BY idx_executor_inbox_attempts_retry
         WHERE attempts_state LIKE 'retry:%'`,
      )
      .all()
      .filter((row) => parseRetry(row.attempts_state).nextAt <= now())
      .sort((a, b) => parseRetry(a.attempts_state).nextAt - parseRetry(b.attempts_state).nextAt)
      .slice(0, 200)
    const payloadOf = db.prepare('SELECT payload_json FROM executor_event_inbox WHERE event_id=?')
    const retries = due.map((row) => ({ ...row, payload_json: payloadOf.get(row.event_id)?.payload_json }))
    const rows = [...todo, ...retries]
    if (!rows.length) return { processed: 0 }
    flushWrites()
    const counts = { processed: rows.length, done: 0, skipped: 0, failed: 0 }
    const mark = db.prepare('UPDATE executor_event_inbox SET attempts_state=? WHERE event_id=?')
    withTransaction(db, () => {
      for (const row of rows) {
        let state = 'skipped'
        // 每行一个保存点：单行中途失败（例如占位行已删、补写未完成）时只回滚这一行
        db.exec('SAVEPOINT attempts_row')
        try {
          const payload = JSON.parse(row.payload_json)
          if (payload?.request_id && Array.isArray(payload.attempts) && payload.attempts.length) {
            applyFinalizedAttempts(db, attemptsRepo, payload)
            state = 'done'
          }
          db.exec('RELEASE attempts_row')
        } catch (error) {
          db.exec('ROLLBACK TO attempts_row')
          db.exec('RELEASE attempts_row')
          const tries = parseRetry(row.attempts_state).tries + 1
          state = tries > RETRY_BACKOFF_MS.length ? 'failed' : `retry:${tries}:${now() + RETRY_BACKOFF_MS[tries - 1]}`
          warn('attempts', `executor events: attempts for ${row.event_id} failed: ${error?.message || error}`)
        }
        counts[state.startsWith('retry') || state === 'failed' ? 'failed' : state]++
        mark.run(state, row.event_id)
      }
    })
    return counts
  }

  function prune() {
    db.prepare('DELETE FROM executor_event_inbox WHERE received_at < ?').run(
      new Date(now() - INBOX_RETENTION_MS).toISOString(),
    )
  }

  // 积压与故障告警（R1 审查 P1-5）：Worker 水位来自心跳（gateway_worker_instances.executor_events_json）
  function warnBacklog(instance, summary) {
    const events = instance.executor_events
    if (!events) return
    if (events.healthy === false) {
      summary.unhealthy++
      warn(
        `unhealthy:${instance.id}`,
        `executor events: ${instance.id} event log unhealthy: ${events.error || 'unknown'}`,
      )
    } else if (Number(events.backlog_bytes) > BACKLOG_WARN_BYTES) {
      summary.backlog++
      warn(
        `backlog:${instance.id}`,
        `executor events: ${instance.id} unacknowledged backlog ${events.backlog_bytes} bytes`,
      )
    }
  }

  async function tick() {
    const activeMode = currentMode()
    const summary = { mode: activeMode, failed: 0, invalid: 0, gaps: 0, streams: 0, unhealthy: 0, backlog: 0 }
    if (activeMode === 'off') return summary
    const instances = repo.listInstances().filter((item) => ['healthy', 'degraded'].includes(item.health_state))
    for (const instance of instances) {
      await pullInstance(instance, activeMode, summary)
      warnBacklog(instance, summary)
    }
    if (activeMode === 'shadow') withTransaction(db, recheckPending)
    else summary.attempts = completeAttempts()
    prune()
    if (summary.failed || summary.invalid || summary.gaps)
      warn('tick', `executor events: tick ${JSON.stringify(summary)}`)
    return summary
  }

  /** 诊断：按类型与状态统计近 since 毫秒内的事件，以及各实例游标与 Worker 水位。 */
  function stats({ since = 24 * 3600_000 } = {}) {
    const events = db
      .prepare(
        'SELECT type,mode,status,COUNT(*) AS n FROM executor_event_inbox WHERE received_at >= ? GROUP BY type,mode,status ORDER BY type,status',
      )
      .all(new Date(now() - since).toISOString())
      .map((row) => ({ ...row }))
    const instances = repo.listInstances().map((instance) => {
      const worker = instance.executor_events || null
      const cursor = worker?.stream_id
        ? db
            .prepare('SELECT last_seq,updated_at FROM executor_event_cursors WHERE instance_id=? AND stream_id=?')
            .get(instance.id, worker.stream_id)
        : null
      return {
        instance_id: instance.id,
        worker,
        cursor: cursor ? { ...cursor } : null,
        lag: worker && cursor ? Math.max(0, Number(worker.head) - Number(cursor.last_seq)) : null,
      }
    })
    const attempts = db
      .prepare(
        "SELECT CASE WHEN attempts_state LIKE 'retry:%' THEN 'retry' ELSE COALESCE(attempts_state,'pending') END AS state,COUNT(*) AS n FROM executor_event_inbox WHERE type='request.finalized' AND mode='primary' AND status='applied' AND received_at >= ? GROUP BY 1",
      )
      .all(new Date(now() - since).toISOString())
      .map((row) => ({ ...row }))
    return { mode: currentMode(), events, attempts, instances }
  }

  return { tick, stats, mode: currentMode }
}
