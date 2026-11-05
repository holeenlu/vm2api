import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function sources(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) sources(full, out)
    else if (entry.name.endsWith('.mjs')) out.push(full)
  }
  return out
}

// withTransaction 的回调同步执行：传入 async 函数时，事务在第一个 await 前就提交，之后的写入不在事务里，
// 抛错也不会回滚（docs/DATA_ACCESS_AND_API_ARCHITECTURE_20261105.md 4.3：事务内不做网络调用）。
test('withTransaction callbacks are synchronous', () => {
  const offenders = []
  for (const file of sources(path.join(ROOT, 'src'))) {
    const text = fs.readFileSync(file, 'utf8')
    for (const match of text.matchAll(/withTransaction\(\s*[^,()]+(?:\([^()]*\))?\s*,\s*async\b/g)) {
      const line = text.slice(0, match.index).split('\n').length
      offenders.push(`${path.relative(ROOT, file)}:${line}`)
    }
  }
  assert.deepEqual(offenders, [], `async callbacks passed to withTransaction:\n${offenders.join('\n')}`)
})

test('the scan recognises an async callback', () => {
  const pattern = /withTransaction\(\s*[^,()]+(?:\([^()]*\))?\s*,\s*async\b/
  assert.match('withTransaction(this.db, async () => {})', pattern)
  assert.match('withTransaction(getDb(), async function () {})', pattern)
  assert.doesNotMatch('withTransaction(db, () => {})', pattern)
})
