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
 * 收件箱读写经 DbClient 异步进行（R6 B3）；GatewayWorkerRepo 的方法 R6 B5 起同样为 async。
 */
import { dbClient } from '../db/db-client.mjs'
import { executorEventsMode, executorPayloadHash, validateExecutorEvent } from './contract.mjs'
import { applyFinalizedAttempts } from './result-writer.mjs'
import { flushWrites } from '../db/write-behind.mjs'
import { databaseWritable, isDatabaseUnavailableError } from '../db/write-health.mjs'
import { usageForStorage } from '../core/usage-persist.mjs'
import { eventInboxRepo } from './repos/event-inbox-repo.mjs'

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
// 同一事件连续处理失败的上限，超过后跳过（终审 A5）
export const POISON_RETRIES = 5
const DONE = new Set(['recorded', 'matched', 'diff', 'pending', 'missing', 'applied', 'stale', 'invalid'])

/**
 * 收件箱保存的载荷：去掉 usage 里的上游 attribution（按会话每条消息累积、无上限、无读取方）。
 * 新版 Worker 生成回执时已去掉；这里兜住旧版 Worker 的事件，收件箱保留 7 天，不能让它重新撑大数据库。
 * 载荷摘要校验在入库前按原始载荷完成；比较已入库内容时两边都按同一规则处理，旧版 Worker 的事件不会被误判为回滚。
 */
export function storedPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload
  const usage = payload.usage
  if (!usage || typeof usage !== 'object' || Array.isArray(usage) || !('attribution' in usage)) return payload
  return { ...payload, usage: usageForStorage(usage) }
}

// 已入库的载荷与新事件的载荷是否相同（按规范化 JSON 摘要比较）
function samePayload(storedJson, payload) {
  try {
    return (
      executorPayloadHash(storedPayload(JSON.parse(storedJson ?? 'null'))) ===
      executorPayloadHash(storedPayload(payload ?? null))
    )
  } catch {
    return false
  }
}

/** RFC3339（小数位数可变）转纳秒（BigInt）；无法解析时为 null。 */
export function timeNanos(value) {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/.exec(String(value || ''))
  if (!match) return null
  const seconds = Date.parse(`${match[1]}${match[3]}`)
  if (!Number.isFinite(seconds)) return null
  return BigInt(seconds / 1000) * 1_000_000_000n + BigInt((match[2] || '').padEnd(9, '0').slice(0, 9) || '0')
}

const payloadDigest = (event) => executorPayloadHash(storedPayload(event.payload ?? null)).slice(0, 12)

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
  const inbox = eventInboxRepo(db)
  const inboxDb = dbClient(db)
  const stamp = () => new Date(now()).toISOString()
  const currentMode = () => mode || executorEventsMode()
  // 告警限频（R1 复审 N3）：同一类告警 5 分钟内只输出一次
  const warnedAt = new Map()
  // 处理失败的事件按 event_id 计数、序号缺口按位置计数（进程内）
  const failures = new Map()
  const gapTries = new Map()
  function warn(key, message) {
    const last = warnedAt.get(key) || 0
    if (now() - last < WARN_INTERVAL_MS) return
    warnedAt.set(key, now())
    log.warn?.(message)
  }

  async function cursorOf(instanceId) {
    return inbox.cursorOf(instanceId)
  }

  // 回滚：游标回到 Worker 已确认的位置（saveCursor 只增不减）
  async function resetCursor(instanceId, streamId, seq) {
    await inbox.resetCursor(instanceId, streamId, seq, stamp())
  }

  // 游标所在序号的事件与已入库的内容不同：Worker 数据目录回滚（终审 A3）
  async function rolledBack(instanceId, streamId, after, data) {
    const head = Number(data?.head)
    if (Number.isFinite(head) && head < after) return true
    const event = (Array.isArray(data?.events) ? data.events : []).find((item) => Number(item?.seq) === after)
    if (!event) return false
    const stored = await inbox.storedPayloadAt(instanceId, streamId, after)
    return !!stored && !samePayload(stored.payload_json, event.payload)
  }

  // 每次成功拉取都刷新 updated_at：心跳据此判断事件链路是否在工作
  async function saveCursor(instanceId, streamId, seq) {
    await inbox.saveCursor(instanceId, streamId, seq, stamp())
  }

  async function writeInbox(event, activeMode, status, detail = null, raw = null) {
    await inbox.write({
      event_id: String(event.event_id),
      instance_id: String(event.instance_id),
      stream_id: String(event.stream_id),
      seq: Number(event.seq) || 0,
      type: String(event.type || 'unknown'),
      occurred_at: String(event.occurred_at || stamp()),
      subject_json: event.subject && typeof event.subject === 'object' ? JSON.stringify(event.subject) : null,
      payload_json: JSON.stringify(
        raw && typeof raw === 'object' && !Array.isArray(raw)
          ? { ...raw, payload: storedPayload(raw.payload) }
          : (raw ?? storedPayload(event.payload ?? null)),
      ),
      mode: activeMode,
      status,
      detail: detail ? String(detail).slice(0, 1000) : null,
      received_at: stamp(),
      checked_at: stamp(),
    })
  }

  // 影子比对：request.finalized 与回执表（按控制面口径重算载荷摘要），probe.recorded 与探测记录。
  // stored：载荷取自收件箱（已按 storedPayload 去掉 attribution），不能再重算摘要，只比较事件声明的摘要（审计 C2）
  async function compare(event, { stored = false } = {}) {
    const payload = event.payload || {}
    if (event.type === 'request.finalized') {
      // 签名有效但载荷缺 dispatch_id：记为 invalid，不抛错卡住事件流（终审 A2）
      if (typeof payload.dispatch_id !== 'string' || !payload.dispatch_id)
        return { status: 'invalid', detail: 'request.finalized without dispatch_id' }
      const { payload_hash: claimed, ...unsigned } = payload
      // 收到时先自检（回执可能尚未到达）：原文摘要与声明不一致即为差异
      if (!stored) {
        const recomputed = executorPayloadHash(unsigned)
        if (recomputed !== claimed)
          return { status: 'diff', detail: `event payload hash ${claimed} != recomputed ${recomputed}` }
      }
      const receipt = await inbox.receiptHash(event.instance_id, payload.dispatch_id)
      if (!receipt) return { status: 'pending' }
      return receipt.payload_hash === claimed
        ? { status: 'matched' }
        : { status: 'diff', detail: `receipt payload_hash ${receipt.payload_hash} != event ${claimed}` }
    }
    if (event.type === 'probe.recorded') {
      const binding = await repo.findAccountByRuntime(event.instance_id, String(payload.account_id || ''))
      if (!binding) return { status: 'diff', detail: 'probe account has no binding' }
      // 探测记录入库时截成毫秒精度（recordBpsProbes），比对按同样口径（R1 审查 P1-1）
      const probedAt = Date.parse(String(payload.probed_at || ''))
      if (!Number.isFinite(probedAt)) return { status: 'diff', detail: 'invalid probed_at' }
      const probe = await inbox.probeAt(
        event.instance_id,
        binding.account_resource_id,
        new Date(probedAt).toISOString(),
      )
      if (!probe) return { status: 'pending' }
      return Boolean(probe.ok) === Boolean(payload.ok) &&
        Number(probe.total_tokens || 0) === Number(payload.total_tokens || 0)
        ? { status: 'matched' }
        : { status: 'diff', detail: 'probe record differs' }
    }
    return { status: 'recorded' }
  }

  // 主来源：调用与旧通道相同的写入函数
  async function apply(event) {
    const payload = event.payload || {}
    switch (event.type) {
      case 'request.finalized': {
        if (payload.gateway_instance_id !== event.instance_id)
          return { status: 'diff', detail: 'receipt instance mismatch' }
        const ingested = await repo.ingestReceipt(payload)
        if (ingested.rejected) return { status: 'diff', detail: ingested.code || 'receipt_rejected' }
        // 回执已由事件入库：让 Worker 清理旧回执目录（不等待，失败由回执重放兜底）
        void Promise.resolve()
          .then(() => client.ackReceipt(event.instance_id, payload.dispatch_id, ingested.receipt_id || null))
          .catch(() => {})
        return { status: 'applied', detail: ingested.duplicate ? 'duplicate' : null }
      }
      case 'account.state': {
        // 整体快照：只应用不早于已应用快照的事件，避免追赶旧事件时把账号终态写回旧值（R1 审查 P1-4）。
        // 按纳秒数值比较时间：Go 的 RFC3339Nano 小数位数可变，不能按字符串比较（终审 A4）；
        // 不按序号比较：数据目录回滚后新事件会复用较小的序号（终审 A3）
        const latest = await inbox.latestAppliedAccountStateAt(event.instance_id)
        const at = timeNanos(event.occurred_at)
        const last = latest ? timeNanos(latest) : null
        if (at !== null && last !== null && at < last) return { status: 'stale' }
        await repo.recordRuntimeCredentials(event.instance_id, Array.isArray(payload.items) ? payload.items : [])
        await onAccountState?.()
        return { status: 'applied' }
      }
      case 'account.quota':
        // recordRuntimeQuotas 自带“已有更新快照时跳过”
        await repo.recordRuntimeQuotas(event.instance_id, Array.isArray(payload.items) ? payload.items : [])
        return { status: 'applied' }
      case 'probe.recorded':
        await repo.recordBpsProbes(event.instance_id, [payload])
        return { status: 'applied' }
      default:
        return { status: 'diff', detail: `unhandled type ${event.type}` }
    }
  }

  async function handle(event, activeMode) {
    const existing = await inbox.get(event.event_id)
    // Worker 数据目录从旧快照恢复后，新事件会复用已处理过的 event_id（流标识与序号相同、内容不同）：
    // 按新事件处理，用带内容摘要的派生 ID 入库（终审 A3）
    if (existing && existing.status !== 'invalid' && !samePayload(existing.payload_json, event.payload)) {
      const derived = `${event.event_id}~${payloadDigest(event)}`
      if (derived !== event.event_id) return handle({ ...event, event_id: derived }, activeMode)
    }
    if (existing && DONE.has(existing.status) && (existing.mode === activeMode || activeMode === 'shadow'))
      return { status: existing.status, duplicate: true }
    const result = activeMode === 'primary' ? await apply(event) : await compare(event)
    await writeInbox(event, activeMode, result.status, result.detail)
    return result
  }

  async function pullInstance(instance, activeMode, summary) {
    const cursor = await cursorOf(instance.id)
    let streamId = cursor?.stream_id || ''
    let after = Number(cursor?.last_seq || 0)
    // 第一页多取游标所在的那一条，用于发现 Worker 数据目录回滚（终审 A3）
    let verify = !!streamId && after > 0
    for (let page = 0; page < MAX_PAGES_PER_TICK; page++) {
      let response
      try {
        response = await client.readEvents(instance.id, {
          after: verify ? after - 1 : after,
          streamId,
          limit: PAGE_LIMIT,
        })
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
      if (verify) {
        verify = false
        if (await rolledBack(instance.id, streamId, after, response.data)) {
          const acked = Math.min(after, Number(response.data?.acked || 0))
          warn(
            `rollback:${instance.id}`,
            `executor events: ${instance.id} stream ${streamId} went back (cursor ${after}, worker head ${response.data?.head}); reprocessing from ${acked}`,
          )
          summary.rollbacks = (summary.rollbacks || 0) + 1
          after = acked
          await resetCursor(instance.id, streamId, after)
          continue
        }
      }
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
          await writeInbox(
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
          await saveCursor(instance.id, streamId, processed)
          continue
        }
        if (event.seq !== processed + 1) {
          // 序号缺口（Worker 已确认的部分已由 floor 排除）：先不处理、不确认，下一轮重试；
          // 连续 POISON_RETRIES 轮仍有同一缺口才接受并告警（终审 B3）
          summary.gaps++
          const gapKey = `${instance.id}|${streamId}|${processed}`
          const tries = (gapTries.get(gapKey) || 0) + 1
          gapTries.set(gapKey, tries)
          if (tries < POISON_RETRIES) {
            warn(
              `gap:${instance.id}`,
              `executor events: ${instance.id} stream ${streamId} skips from ${processed} to ${event.seq}; retrying`,
            )
            stuck = true
            break
          }
          gapTries.delete(gapKey)
          warn(
            `gap-accepted:${instance.id}`,
            `executor events: ${instance.id} stream ${streamId} gap ${processed + 1}..${event.seq - 1} accepted after ${tries} tries`,
          )
        }
        let result
        try {
          result = await handle(event, activeMode)
          failures.delete(event.event_id)
        } catch (error) {
          // 控制面数据库写不进去（写锁被占、只读、磁盘满）不是事件本身的问题：不计入毒事件次数、不推进游标，
          // 恢复后下一轮重试（降级演练 M3）。否则数据库故障期间同一事件失败 5 次就会被跳过
          if (isDatabaseUnavailableError(error)) {
            summary.failed++
            stuck = true
            warn(
              `db:${instance.id}`,
              `executor events: ${event.event_id} waits for the database: ${error?.message || error}`,
            )
            break
          }
          await writeInbox(event, activeMode, 'failed', error?.message || error)
          summary.failed++
          const tries = (failures.get(event.event_id) || 0) + 1
          failures.set(event.event_id, tries)
          // 同一事件连续失败 POISON_RETRIES 次：记为 failed 并跳过，不让一条毒事件卡住整条流
          // （回执重放与下一次快照兜底；收件箱 failed 状态计入比对工具的问题数，终审 A5）
          if (tries >= POISON_RETRIES) {
            failures.delete(event.event_id)
            warn(
              `poison:${instance.id}`,
              `executor events: ${event.event_id} failed ${tries} times and is skipped: ${error?.message || error}`,
            )
            processed = event.seq
            await saveCursor(instance.id, streamId, processed)
            continue
          }
          stuck = true
          warn(`failed:${instance.id}`, `executor events: ${event.event_id} failed: ${error?.message || error}`)
          break
        }
        const key = result.duplicate ? 'duplicate' : result.status
        summary[key] = (summary[key] || 0) + 1
        processed = event.seq
        await saveCursor(instance.id, streamId, processed)
      }
      // 没有新事件也刷新游标时间：表示事件链路在工作；卡在失败事件上时不刷新，让心跳兜底（R1 复审 N2）
      if (!stuck) await saveCursor(instance.id, streamId, processed)
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
  async function recheckPending() {
    const rows = await inbox.pending()
    for (const row of rows) {
      const event = { ...row, subject: null, payload: JSON.parse(row.payload_json) }
      const result = await compare(event, { stored: true })
      if (result.status === 'pending' && now() - Date.parse(row.received_at) > PENDING_TIMEOUT_MS)
        result.status = 'missing'
      if (result.status !== 'pending')
        await inbox.markChecked(row.event_id, result.status, result.detail || null, stamp())
    }
  }

  // 主来源模式：request.finalized 入库 60 秒后（实时写入已完成）按事件补齐请求尝试（P2.3）。
  // 先提交写回队列；整批放进一个事务、每行一个保存点；失败行按 1、5、15 分钟退避重试 3 次，之后记为 failed
  // （R2 P2-2、P2-3，R2 复审 N1、N3、N4）。两条查询与迁移 104 的部分索引条件逐字一致，并以 INDEXED BY 指定。
  async function completeAttempts() {
    if (!attemptsRepo) return { processed: 0 }
    const todo = await inbox.attemptsTodo(new Date(now() - ATTEMPTS_DELAY_MS).toISOString())
    // 先只取状态列，按到期时间在 JS 里筛出已到期的再取载荷：退避中的行再多也不会挡住已到期的行（R2 第二轮复审 N8）
    const due = (await inbox.attemptsRetries())
      .filter((row) => parseRetry(row.attempts_state).nextAt <= now())
      .sort((a, b) => parseRetry(a.attempts_state).nextAt - parseRetry(b.attempts_state).nextAt)
      .slice(0, 200)
    const retries = []
    for (const row of due) retries.push({ ...row, payload_json: await inbox.payloadJson(row.event_id) })
    const rows = [...todo, ...retries]
    if (!rows.length) return { processed: 0 }
    await flushWrites()
    const counts = { processed: rows.length, done: 0, skipped: 0, failed: 0 }
    await inboxDb.tx(async (tx) => {
      for (const row of rows) {
        let state = 'skipped'
        // 每行一个保存点（嵌套 tx）：单行中途失败（例如占位行已删、补写未完成）时只回滚这一行
        try {
          state = await tx.tx(async () => {
            const payload = JSON.parse(row.payload_json)
            if (payload?.request_id && Array.isArray(payload.attempts) && payload.attempts.length)
              // 不是客户端请求或已有 VM 尝试（终审复核 N1）：记为 not_client，比对工具不比较尝试条数
              return (await applyFinalizedAttempts(db, attemptsRepo, payload)).skipped ? 'not_client' : 'done'
            return 'skipped'
          })
        } catch (error) {
          const tries = parseRetry(row.attempts_state).tries + 1
          state = tries > RETRY_BACKOFF_MS.length ? 'failed' : `retry:${tries}:${now() + RETRY_BACKOFF_MS[tries - 1]}`
          warn('attempts', `executor events: attempts for ${row.event_id} failed: ${error?.message || error}`)
        }
        counts[state.startsWith('retry') || state === 'failed' ? 'failed' : state]++
        await inbox.markAttempts(row.event_id, state)
      }
    })
    return counts
  }

  async function prune() {
    await inbox.pruneBefore(new Date(now() - INBOX_RETENTION_MS).toISOString())
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
    // 控制面数据库写不进去（M3 复审 P2-10）：本轮不拉取、不处理，事件留在 Worker，恢复后照常补交
    if (!databaseWritable()) {
      summary.skipped = 'database_unavailable'
      return summary
    }
    if (activeMode === 'off') {
      // 从 primary 切回 off：不再拉取，但之前入库、尚未补齐的尝试照常补齐，收件箱照常按保留期清理（审计 U5）
      summary.attempts = await completeAttempts()
      await prune()
      return summary
    }
    // 待批准的实例（中期技术债 M2 复审 P1-1）不采信其事件
    const instances = (await repo.listInstances()).filter(
      (item) => ['healthy', 'degraded'].includes(item.health_state) && item.approval_state !== 'pending',
    )
    for (const instance of instances) {
      await pullInstance(instance, activeMode, summary)
      warnBacklog(instance, summary)
    }
    if (activeMode === 'shadow') await inboxDb.tx(() => recheckPending())
    else summary.attempts = await completeAttempts()
    await prune()
    if (summary.failed || summary.invalid || summary.gaps)
      warn('tick', `executor events: tick ${JSON.stringify(summary)}`)
    return summary
  }

  /** 诊断：按类型与状态统计近 since 毫秒内的事件，以及各实例游标与 Worker 水位。 */
  async function stats({ since = 24 * 3600_000 } = {}) {
    const events = (await inbox.countsSince(new Date(now() - since).toISOString())).map((row) => ({ ...row }))
    const instances = []
    for (const instance of await repo.listInstances()) {
      const worker = instance.executor_events || null
      const cursor = worker?.stream_id ? await inbox.cursorAt(instance.id, worker.stream_id) : null
      instances.push({
        instance_id: instance.id,
        worker,
        cursor: cursor ? { ...cursor } : null,
        lag: worker && cursor ? Math.max(0, Number(worker.head) - Number(cursor.last_seq)) : null,
      })
    }
    const attempts = (await inbox.attemptStatesSince(new Date(now() - since).toISOString())).map((row) => ({
      ...row,
    }))
    return { mode: currentMode(), events, attempts, instances }
  }

  return { tick, stats, mode: currentMode }
}
