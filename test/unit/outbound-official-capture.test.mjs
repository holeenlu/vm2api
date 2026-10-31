/** Snapshot of unofficial mimicry header/body shape against official Claude Code 2.1.281. */
/** Captured from the official Linux x64 binary with no tokens. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  applyCrsUnofficialPersona,
  computeClaudeCodeFingerprint,
  CRS_OFFICIAL_SYSTEM,
  CRS_AGENT_EXPANSION,
  AGENT_EXPANSION_CACHE_CONTROL,
} from '../../src/lib/identity/crs-persona.mjs'
import { loadVmIdentity, OFFICIAL_CLI_VERSION, OFFICIAL_CLAUDE_CLI_UA } from '../../src/lib/identity/vm-identity.mjs'
import { prepareOutboundEnvelope } from '../../src/lib/protocol/outbound-attempt.mjs'

test('inbound claude-sonnet-5[1m] injects 1M beta and strips outbound model', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-1m-'))
  const identity = {
    vmId: 'vm-29',
    deviceId: 'd'.repeat(64),
    accountUuid: '11111111-1111-4111-8111-111111111111',
    timezone: 'America/Los_Angeles',
    userAgent: 'claude-cli/2.1.241 (external, sdk-cli)',
    fingerprint: { locale: 'en_US.UTF-8', timezone: 'America/Los_Angeles' },
  }
  const envelope = prepareOutboundEnvelope({
    canonicalBody: {
      model: 'claude-sonnet-5',
      max_tokens: 128000,
      messages: [{ role: 'user', content: 'hi' }],
    },
    inbound: { model: 'claude-sonnet-5[1m]', max_tokens: 128000, messages: [{ role: 'user', content: 'hi' }] },
    identity,
    unofficial: true,
    stream: true,
    reqHeaders: { 'user-agent': 'Go-http-client/2.0' },
    homeDir: dir,
  })
  assert.equal(envelope.body.model, 'claude-sonnet-5')
  assert.match(String(envelope.headers['anthropic-beta'] || ''), /context-1m-2025-08-07/)
  fs.rmSync(dir, { recursive: true, force: true })
})

/** Capture first-user bytes at indexes 4/7/20 such that 2.1.281 fp is 6f0. */
const CAPTURE_281_FIRST_USER = (() => {
  const buf = Buffer.alloc(21, 0x78)
  buf[4] = 0x61 // a
  buf[7] = 0x4d // M
  buf[20] = 0x31 // 1
  return buf.toString('utf8')
})()

test('outbound headers use the official CLI pin and keep the 2.1.281 fingerprint vector', () => {
  assert.equal(computeClaudeCodeFingerprint(CAPTURE_281_FIRST_USER, '2.1.281'), '6f0')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-281-'))
  const identity = loadVmIdentity({
    vmId: 'vm-29',
    homeDir: dir,
    vm: { id: 'vm-29', timezone: 'America/Los_Angeles', locale: 'en_US.UTF-8' },
  })
  const inbound = {
    model: 'claude-sonnet-5',
    max_tokens: 128000,
    stream: true,
    messages: [{ role: 'user', content: CAPTURE_281_FIRST_USER }],
  }
  const persona = applyCrsUnofficialPersona(inbound, {
    officialClient: false,
    mode: 'rewrite',
    sessionId: '11111111-1111-4111-8111-111111111111',
    identity,
    model: inbound.model,
  })
  const envelope = prepareOutboundEnvelope({
    canonicalBody: persona,
    inbound,
    identity,
    unofficial: true,
    stream: true,
    reqHeaders: { 'user-agent': 'RikkaHub/1.0' },
    homeDir: dir,
    sessionId: '11111111-1111-4111-8111-111111111111',
    firstUserText: CAPTURE_281_FIRST_USER,
  })
  const { headers, body } = envelope
  assert.equal(headers['user-agent'], OFFICIAL_CLAUDE_CLI_UA)
  assert.equal(headers['anthropic-version'], '2023-06-01')
  assert.equal(headers['x-app'], 'cli')
  assert.equal(headers['anthropic-dangerous-direct-browser-access'], 'true')
  assert.equal(headers['x-stainless-lang'], 'js')
  assert.equal(headers['x-stainless-os'], 'Linux')
  assert.equal(headers['x-stainless-arch'], 'x64')
  assert.equal(headers['x-stainless-runtime'], 'node')
  assert.equal(headers['x-stainless-runtime-version'], 'v26.3.0')
  assert.equal(headers['x-stainless-retry-count'], '0')
  assert.equal(headers['x-stainless-timeout'], '600')
  assert.match(
    body.system[2].text,
    new RegExp(
      `cc_version=${OFFICIAL_CLI_VERSION.replaceAll('.', '\\.')}\\.${computeClaudeCodeFingerprint(CAPTURE_281_FIRST_USER, OFFICIAL_CLI_VERSION)}`,
    ),
  )
  assert.match(body.system[2].text, /cc_prompt_index=0; cc_turn_index=1;/)
  const uid = JSON.parse(body.metadata.user_id)
  assert.equal(headers['x-claude-code-session-id'], uid.session_id)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('official rebuild does not leak inbound A into headers, metadata, or billing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-281-official-'))
  const inboundA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const rebuilt = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const identity = {
    vmId: 'vm-29',
    deviceId: 'd'.repeat(64),
    accountUuid: '11111111-1111-4111-8111-111111111111',
    timezone: 'America/Los_Angeles',
    locale: 'en_US.UTF-8',
    userAgent: 'claude-cli/2.1.281 (external, sdk-cli)',
    fingerprint: {
      x_app: 'cli',
      stainless_lang: 'js',
      stainless_os: 'Linux',
      stainless_arch: 'x64',
      stainless_runtime: 'node',
      stainless_runtime_version: 'v26.3.0',
      stainless_package_version: '0.112.1',
      locale: 'en_US.UTF-8',
      timezone: 'America/Los_Angeles',
    },
  }
  const inbound = {
    model: 'claude-sonnet-5',
    max_tokens: 128000,
    stream: true,
    messages: [{ role: 'user', content: 'hello' }],
    system: [
      {
        type: 'text',
        text: `x-anthropic-billing-header: cc_version=2.1.281.abc; cc_entrypoint=sdk-cli; cch=00000; cc_prompt_id=${inboundA};`,
      },
    ],
    metadata: { user_id: JSON.stringify({ session_id: inboundA }) },
  }
  const envelope = prepareOutboundEnvelope({
    canonicalBody: inbound,
    inbound,
    identity,
    unofficial: false,
    officialClient: true,
    stream: true,
    reqHeaders: {
      'user-agent': 'claude-cli/2.1.281 (external, sdk-cli)',
      'x-claude-code-session-id': inboundA,
    },
    homeDir: dir,
    sessionId: rebuilt,
    mode: 'rebuild',
    firstUserText: 'hello',
  })
  const uid = JSON.parse(envelope.body.metadata.user_id)
  assert.notEqual(uid.session_id, inboundA)
  assert.equal(uid.session_id, rebuilt)
  assert.equal(envelope.headers['x-claude-code-session-id'], rebuilt)
  assert.match(envelope.body.system[0].text, new RegExp(`cc_prompt_id=${rebuilt}`))
  assert.equal(String(envelope.body.system[0].text).includes(inboundA), false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('official passthrough keeps the caller billing prompt id', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-281-pass-'))
  const inboundA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const identity = {
    vmId: 'vm-29',
    deviceId: 'd'.repeat(64),
    accountUuid: '11111111-1111-4111-8111-111111111111',
    userAgent: 'claude-cli/2.1.281 (external, sdk-cli)',
    fingerprint: { locale: 'en_US.UTF-8', timezone: 'America/Los_Angeles' },
  }
  const inbound = {
    model: 'claude-sonnet-5',
    max_tokens: 32,
    messages: [{ role: 'user', content: 'hello' }],
    system: [
      {
        type: 'text',
        text: `x-anthropic-billing-header: cc_version=2.1.281.abc; cc_entrypoint=sdk-cli; cch=00000; cc_prompt_id=${inboundA};`,
      },
    ],
    metadata: { user_id: JSON.stringify({ session_id: inboundA }) },
  }
  const envelope = prepareOutboundEnvelope({
    canonicalBody: inbound,
    inbound,
    identity,
    unofficial: false,
    officialClient: true,
    stream: true,
    reqHeaders: {
      'user-agent': 'claude-cli/2.1.281 (external, sdk-cli)',
      'x-claude-code-session-id': inboundA,
    },
    homeDir: dir,
    sessionId: inboundA,
    mode: 'passthrough',
    firstUserText: 'hello',
  })
  const uid = JSON.parse(envelope.body.metadata.user_id)
  assert.equal(uid.session_id, inboundA)
  assert.equal(envelope.headers['x-claude-code-session-id'], inboundA)
  assert.match(envelope.body.system[0].text, new RegExp(`cc_prompt_id=${inboundA}`))
  fs.rmSync(dir, { recursive: true, force: true })
})
