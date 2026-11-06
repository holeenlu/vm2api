import test from 'node:test'
import assert from 'node:assert/strict'
import { verifySignedResponse } from '../../src/lib/gateway-worker/gateway-client.mjs'
import { bodyHash, signGatewayRequest } from '../../src/lib/gateway-worker/gateway-auth.mjs'

const secret = 'internal-token'
const path = '/internal/v1/events'
const signed = (text, nonce, status = 200) => {
  const hash = bodyHash(text)
  return {
    text,
    status,
    headers: {
      'x-kin-gateway-response-sha256': hash,
      'x-kin-gateway-response-signature': signGatewayRequest({
        secret,
        timestamp: `resp ${status} ${path}?after=0`,
        nonce,
        hash,
        body: text,
      }),
    },
  }
}

test('event page responses must carry a signature bound to the request nonce (P3.11)', () => {
  const response = signed('{"ok":true,"events":[]}', 'n1')
  const target = `${path}?after=0`
  assert.equal(verifySignedResponse(secret, 'n1', response, target), true)
  assert.equal(verifySignedResponse(secret, 'n1', response, `${path}?after=5`), false, 'the query is signed (B3)')
  assert.equal(verifySignedResponse(secret, 'n2', response, target), false, 'replayed to another request')
  assert.equal(verifySignedResponse('other', 'n1', response, target), false, 'wrong secret')
  assert.equal(verifySignedResponse(secret, 'n1', { ...response, status: 409 }, target), false, 'status is signed')
  assert.equal(verifySignedResponse(secret, 'n1', response, '/internal/v1/other'), false, 'path is signed')
  assert.equal(verifySignedResponse(secret, 'n1', { ...response, text: '{"ok":true,"events":[1]}' }, target), false)
  assert.equal(
    verifySignedResponse(secret, 'n1', { text: response.text, status: 200, headers: {} }, target),
    false,
    'unsigned (old Worker)',
  )
})
