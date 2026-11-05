import test from 'node:test'
import assert from 'node:assert/strict'
import {
  callIdFromLocation,
  codexRealtimeModel,
  createLiveCallDirectory,
  isLiveCallPath,
  liveErrorBody,
  liveHangupCallId,
  liveSidebandTarget,
  normalizeLiveCallRequest,
} from '../../src/lib/protocol/codex-live.mjs'

test('live call bodies normalize SDP, JSON and multipart to the upstream JSON contract', () => {
  const sdp = normalizeLiveCallRequest(Buffer.from('v=0 offer'), 'application/sdp')
  assert.deepEqual(JSON.parse(sdp.body), { sdp: 'v=0 offer' })
  assert.equal(sdp.model, 'gpt-live-1-codex')
  const json = normalizeLiveCallRequest(
    Buffer.from('{"sdp":"x","session":{"model":"gpt-realtime-mini","voice":"a"}}'),
    'application/json',
  )
  assert.deepEqual(JSON.parse(json.body), { sdp: 'x', session: { model: 'gpt-live-1-codex', voice: 'a' } })
  const custom = normalizeLiveCallRequest(Buffer.from('{"sdp":"x","model":"gpt-live-2"}'), 'application/json')
  assert.equal(custom.model, 'gpt-live-2')
  const boundary = 'BOUNDARY'
  const form = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="sdp"\r\n\r\nv=0 multi\r\n--${boundary}\r\nContent-Disposition: form-data; name="session"\r\n\r\n{"model":"gpt-realtime"}\r\n--${boundary}--\r\n`,
  )
  const multipart = normalizeLiveCallRequest(form, `multipart/form-data; boundary=${boundary}`)
  assert.deepEqual(JSON.parse(multipart.body), { sdp: 'v=0 multi', session: { model: 'gpt-live-1-codex' } })
  assert.equal(normalizeLiveCallRequest(Buffer.from('  '), 'application/sdp').ok, false)
  assert.equal(codexRealtimeModel('gpt-4o-realtime-preview'), 'gpt-live-1-codex')
})

test('live routing helpers parse calls, hangups and sideband styles', () => {
  assert.ok(
    isLiveCallPath('/v1/live') && isLiveCallPath('/v1/realtime/calls') && !isLiveCallPath('/v1/realtime/calls/x'),
  )
  assert.equal(liveHangupCallId('/v1/realtime/calls/rtc_1/hangup'), 'rtc_1')
  assert.deepEqual(liveSidebandTarget('/v1/live/rtc_1'), { callId: 'rtc_1', style: 'live' })
  assert.deepEqual(liveSidebandTarget('/v1/realtime/calls/rtc_2'), { callId: 'rtc_2', style: 'realtime_calls' })
  assert.deepEqual(liveSidebandTarget('/v1/realtime?call_id=rtc_3'), { callId: 'rtc_3', style: 'realtime_query' })
  assert.deepEqual(liveSidebandTarget('/v1/realtime?model=gpt-realtime'), { callId: null, style: 'realtime_direct' })
  assert.equal(liveSidebandTarget('/v1/responses'), null)
  assert.equal(callIdFromLocation('https://x/v1/realtime/calls/rtc_4?y=1'), 'rtc_4')
  assert.equal(callIdFromLocation('/v1/realtime?call_id=rtc_5&intent=quicksilver'), 'rtc_5')
  assert.deepEqual(liveErrorBody('live', 404, 'gone', 'call_not_found'), { error: 'gone' })
  assert.equal(liveErrorBody('realtime', 404, 'gone', 'call_not_found').error.code, 'call_not_found')
})

test('live call directory pins the creating Worker and caller', () => {
  const directory = createLiveCallDirectory()
  directory.remember('rtc_1', 'gw_a', 'scope_1')
  assert.deepEqual(
    { instanceId: directory.lookup('rtc_1').instanceId, clientScope: directory.lookup('rtc_1').clientScope },
    { instanceId: 'gw_a', clientScope: 'scope_1' },
  )
  directory.forget('rtc_1')
  assert.equal(directory.lookup('rtc_1'), null)
})
