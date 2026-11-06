/**
 * Which account signed each thinking block.
 *
 * A thinking block's signature only verifies on the account that produced
 * it; replayed to another account it is a 400. Every Claude response records
 * its thinking blocks under the account that served it. Before a hop goes
 * out, only the hop account's own blocks stay thinking. Any other block —
 * signed by another account, or with no record at all — goes as a plain text
 * block with its thinking text, and is dropped when that text is empty.
 *
 * Key: sha256 of the signature's length, first 100 and last 100 characters
 * (`data` for redacted_thinking). The table lives outside the versioned
 * migrations so this local addition cannot take a migration number later.
 * SQL 在 db/repos/thinking-owners-repo.mjs，经 DbClient 异步执行（R6 B7b）。
 */
import crypto from 'node:crypto'
import { getDb } from '../db/database.mjs'
import { ThinkingOwnersRepo } from '../db/repos/thinking-owners-repo.mjs'
import { mapThinkingBlocks } from '../protocol/anthropic-policy.mjs'

const EDGE = 100
const MIN_SIGNATURE = 24
const TTL_MS = 30 * 24 * 60 * 60 * 1000
const PURGE_EVERY_MS = 60 * 60 * 1000
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000

/** Stable key for one signed thinking block, or null when it carries no usable signature. */
export function thinkingSignatureKey(block) {
  const raw = block?.type === 'thinking' ? block.signature : block?.type === 'redacted_thinking' ? block.data : null
  const signature = String(raw || '').trim()
  if (signature.length < MIN_SIGNATURE) return null
  const material = signature.length <= EDGE * 2 ? signature : signature.slice(0, EDGE) + signature.slice(-EDGE)
  return crypto.createHash('sha256').update(`${signature.length}:${material}`).digest('hex').slice(0, 32)
}

export class ThinkingOwnerStore {
  /** `db` pins a connection (tests); otherwise the process database, re-read so a restore rebinds. */
  constructor({ db = null, ttlMs = TTL_MS } = {}) {
    this.pinned = db
    this.ttlMs = ttlMs
    this.boundDb = null
    this.lastPurge = 0
  }

  /** The repository for the current connection; the table is created once per connection. */
  async repo() {
    let db
    try {
      db = this.pinned || getDb()
    } catch {
      return null
    }
    if (this.boundDb === db) {
      await this.ready
      return this.sql
    }
    const repo = new ThinkingOwnersRepo(db)
    this.boundDb = db
    this.sql = repo
    this.ready = repo.ensureTable()
    try {
      await this.ready
    } catch (error) {
      if (this.boundDb === db) this.boundDb = null
      throw error
    }
    return repo
  }

  /**
   * key → account for the keys that have a record; null when no database is
   * reachable, so the caller can leave history alone instead of guessing.
   */
  async ownersOf(keys, now = Date.now()) {
    const repo = await this.repo()
    if (!repo) return null
    const found = new Map()
    if (!keys.length) return found
    for (const [key, account] of await repo.owners(keys)) found.set(key, account)
    if (found.size) await repo.refresh(keys, now, now - REFRESH_AFTER_MS)
    return found
  }

  /** First writer wins: a signature belongs to the account that returned it. */
  async record(keys, accountId, now = Date.now()) {
    const account = String(accountId || '')
    const repo = keys.length && account ? await this.repo() : null
    if (!repo) return
    for (const key of keys) await repo.insert(key, account, now)
    if (now - this.lastPurge >= PURGE_EVERY_MS) {
      this.lastPurge = now
      await repo.purge(now - this.ttlMs)
    }
  }
}

export const thinkingOwners = new ThinkingOwnerStore()

function historyKeys(body) {
  const keys = []
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      const key = thinkingSignatureKey(block)
      if (key) keys.push(key)
    }
  }
  return keys
}

/**
 * The body this account may replay: its own thinking stays, every other
 * signed block becomes text (dropped when empty). Without a reachable
 * database the body goes unchanged.
 * @returns {{ body: object, kept: number, converted: number, dropped: number, unknown: number }}
 */
export async function filterThinkingForAccount(body, accountId, store = thinkingOwners) {
  const account = String(accountId || '')
  const counts = { kept: 0, converted: 0, dropped: 0, unknown: 0 }
  const keys = account ? historyKeys(body) : []
  if (!keys.length) return { body, ...counts }
  let owners = null
  try {
    owners = await store.ownersOf([...new Set(keys)])
  } catch {}
  if (!owners) return { body, ...counts, kept: keys.length }
  const out = mapThinkingBlocks(body, (block, message) => {
    const key = message?.role === 'assistant' ? thinkingSignatureKey(block) : null
    // Unsigned blocks are stripInvalidThinkingBlocks' call.
    if (!key) return block
    const owner = owners.get(key)
    if (owner === account) {
      counts.kept += 1
      return block
    }
    if (owner == null) counts.unknown += 1
    const text = block.type === 'thinking' ? String(block.thinking || '') : ''
    if (text.trim()) {
      counts.converted += 1
      return { type: 'text', text }
    }
    counts.dropped += 1
    return null
  })
  return { body: out.body, ...counts }
}

/** Bind the thinking blocks of a served response to the account that produced them. */
export async function recordThinkingOwners(message, accountId, store = thinkingOwners) {
  const keys = []
  for (const block of Array.isArray(message?.content) ? message.content : []) {
    const key = thinkingSignatureKey(block)
    if (key) keys.push(key)
  }
  try {
    await store.record(keys, accountId)
  } catch {}
  return keys.length
}
