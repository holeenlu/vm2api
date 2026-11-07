import test from 'node:test'
import assert from 'node:assert/strict'
import {
  LOGIN_MAX_FAILURES_PER_IP,
  LOGIN_MAX_FAILURES_PER_USER,
  LOGIN_WINDOW_MS,
  createLoginThrottle,
} from '../../src/lib/admin/login-throttle.mjs'

test('login failures lock the username and the source address for the window (audit P1-S2)', () => {
  let now = 1_000_000
  const throttle = createLoginThrottle({ now: () => now })
  for (let i = 0; i < LOGIN_MAX_FAILURES_PER_USER; i++) {
    assert.equal(throttle.retryAfterMs('Alice', '1.2.3.4'), 0)
    throttle.fail('alice', `10.0.0.${i}`)
  }
  assert.ok(throttle.retryAfterMs('ALICE', '9.9.9.9') > 0, 'username lock ignores the source address')
  assert.equal(throttle.retryAfterMs('bob', '9.9.9.9'), 0)
  now += LOGIN_WINDOW_MS
  assert.equal(throttle.retryAfterMs('alice', '9.9.9.9'), 0, 'the window expires')

  for (let i = 0; i < LOGIN_MAX_FAILURES_PER_IP; i++) throttle.fail(`user${i}`, '5.5.5.5')
  assert.ok(throttle.retryAfterMs('someone-else', '5.5.5.5') > 0, 'spraying usernames from one address is limited')

  throttle.fail('carol', '7.7.7.7')
  throttle.succeed('carol')
  for (let i = 0; i < LOGIN_MAX_FAILURES_PER_USER - 1; i++) throttle.fail('carol', '7.7.7.7')
  assert.equal(throttle.retryAfterMs('carol', '8.8.8.8'), 0, 'a successful login resets the username count')
})
