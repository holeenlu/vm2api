import test from 'node:test'
import assert from 'node:assert/strict'

// 生产环境缺少密钥时拒绝回退（审计 P2）：Key 哈希不能用公开的开发密钥，密文字段不能以明文落库
const SECRET_ENV = [
  'NODE_ENV',
  'TAPMODELS_API_KEY_HASH_SECRET',
  'KIN_API_KEY_HASH_SECRET',
  'TAPMODELS_DB_SECRET',
  'KIN_DB_SECRET',
  'TAPMODELS_API_KEY',
  'KIN_API_KEY',
]

function withEnv(values, fn) {
  const saved = Object.fromEntries(SECRET_ENV.map((key) => [key, process.env[key]]))
  for (const key of SECRET_ENV) delete process.env[key]
  Object.assign(process.env, values)
  try {
    return fn()
  } finally {
    for (const key of SECRET_ENV) {
      if (saved[key] == null) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
}

test('production refuses to encrypt without a database secret; development keeps the plaintext fallback', async () => {
  const { maybeEncrypt, maybeDecrypt } = await import('../../src/lib/db/secure.mjs')
  withEnv({ NODE_ENV: 'production' }, () => {
    assert.throws(() => maybeEncrypt('token'), /database secret missing/)
  })
  withEnv({ NODE_ENV: 'production', TAPMODELS_DB_SECRET: 'unit-secret' }, () => {
    const sealed = maybeEncrypt('token')
    assert.match(sealed, /^enc:v1:/)
    assert.equal(maybeDecrypt(sealed), 'token')
  })
  withEnv({ NODE_ENV: 'test' }, () => {
    assert.equal(maybeEncrypt('token'), 'token')
  })
})

test('production refuses the development API key hash secret', async () => {
  const { ApiKeyStore } = await import('../../src/lib/admin/api-keys.mjs')
  const db = { prepare: () => ({ get: () => null, all: () => [], run: () => ({}) }) }
  withEnv({ NODE_ENV: 'production' }, () => {
    assert.throws(() => new ApiKeyStore({ db }), /API key hash secret missing/)
  })
  withEnv({ NODE_ENV: 'production' }, () => {
    assert.equal(new ApiKeyStore({ db, hashSecret: 'explicit' }).hashSecret, 'explicit')
  })
  withEnv({ NODE_ENV: 'test' }, () => {
    assert.equal(new ApiKeyStore({ db }).hashSecret, 'kin-development-api-key-hash-secret')
  })
})
