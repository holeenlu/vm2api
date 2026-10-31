import test from 'node:test'
import assert from 'node:assert/strict'
import { parseProxyLine, parseProxyFields } from '../../src/lib/vm/proxy-pool.mjs'

test('recognizes host:port:user:pass vendor lines as socks5', () => {
  const parsed = parseProxyLine('154.9.177.229:5509:howwaqev:lgg15vfswgy8')
  assert.equal(parsed.scheme, 'socks5')
  assert.equal(parsed.host, '154.9.177.229')
  assert.equal(parsed.port, 5509)
  assert.equal(parsed.username, 'howwaqev')
  assert.equal(parsed.password, 'lgg15vfswgy8')
})

test('recognizes user:pass@host:port and socks5 URLs', () => {
  const at = parseProxyLine('howwaqev:lgg15vfswgy8@154.9.177.229:5509')
  assert.equal(at.host, '154.9.177.229')
  assert.equal(at.port, 5509)
  assert.equal(at.username, 'howwaqev')
  const url = parseProxyLine('socks5h://howwaqev:lgg15vfswgy8@154.9.177.229:5509')
  assert.equal(url.host, '154.9.177.229')
  assert.equal(url.username, 'howwaqev')
})

test('recognizes user:pass:host:port and structured fields', () => {
  const flipped = parseProxyLine('howwaqev:lgg15vfswgy8:154.9.177.229:5509')
  assert.equal(flipped.host, '154.9.177.229')
  assert.equal(flipped.port, 5509)
  assert.equal(flipped.username, 'howwaqev')
  const fields = parseProxyFields({
    host: '154.9.177.229',
    port: '5509',
    username: 'howwaqev',
    password: 'secret',
  })
  assert.equal(fields.scheme, 'socks5')
  assert.equal(fields.port, 5509)
  assert.equal(fields.username, 'howwaqev')
})

test('rejects incomplete or non-proxy lines', () => {
  assert.equal(parseProxyLine(''), null)
  assert.equal(parseProxyLine('# comment'), null)
  assert.equal(parseProxyLine('154.9.177.229'), null)
  assert.equal(parseProxyFields({ host: '154.9.177.229' }), null)
})
