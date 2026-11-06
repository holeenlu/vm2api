import test from 'node:test'
import assert from 'node:assert/strict'
import { parseNumstat, summarize } from '../../scripts/upstream-touch-budget.mjs'

test('upstream touch budget counts only files that exist upstream', () => {
  const changes = parseNumstat(
    [
      '12\t3\tsrc/server.mjs',
      '40\t0\tsrc/lib/executor/contract.mjs',
      '-\t-\tweb/public/logo.png',
      '0\t5\tsrc/config/routing.json',
      '',
    ].join('\n'),
  )
  assert.equal(changes.length, 4)
  assert.deepEqual(changes[2], { path: 'web/public/logo.png', added: 0, deleted: 0, binary: true })
  const upstream = new Set(['src/server.mjs', 'src/config/routing.json', 'web/public/logo.png'])
  const result = summarize(changes, (file) => upstream.has(file))
  assert.equal(result.file_count, 3)
  assert.equal(result.added, 12)
  assert.equal(result.deleted, 8)
  assert.deepEqual(
    result.files.map((file) => file.path),
    ['src/server.mjs', 'web/public/logo.png', 'src/config/routing.json'],
  )
})
