#!/usr/bin/env node
/**
 * 上游改动预算（docs/control-plane/DEVELOPMENT_PLAN.md 2.7）：统计 <base> 到当前工作树（含已暂存与未跟踪文件）的改动中，
 * 落在上游基线已有文件上的部分。上游基线默认取 <base>^（main 为“上游基线 + 一个定制提交”）。
 *
 * 用法：node scripts/upstream-touch-budget.mjs <base> [--upstream <sha>] [--json]
 */
import { execFileSync } from 'node:child_process'

export function parseNumstat(text) {
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [added, deleted, ...rest] = line.split('\t')
      const binary = added === '-' || deleted === '-'
      return { path: rest.join('\t'), added: binary ? 0 : Number(added), deleted: binary ? 0 : Number(deleted), binary }
    })
}

/** 只保留上游基线中已存在的文件，汇总行数。 */
export function summarize(changes, existsInUpstream) {
  const files = changes.filter((change) => existsInUpstream(change.path))
  return {
    files,
    file_count: files.length,
    added: files.reduce((sum, file) => sum + file.added, 0),
    deleted: files.reduce((sum, file) => sum + file.deleted, 0),
  }
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] })
}

function main(argv) {
  const args = [...argv]
  const json = args.includes('--json')
  const upstreamIndex = args.indexOf('--upstream')
  const upstreamArg = upstreamIndex >= 0 ? args[upstreamIndex + 1] : null
  const base = args.find((arg, index) => !arg.startsWith('--') && (upstreamIndex < 0 || index !== upstreamIndex + 1))
  if (!base) {
    console.error('usage: node scripts/upstream-touch-budget.mjs <base> [--upstream <sha>] [--json]')
    process.exit(2)
  }
  const cwd = process.cwd()
  const upstream = upstreamArg || git(['rev-parse', `${base}^`], cwd).trim()
  // 把未跟踪文件以 intent-to-add 方式计入，统计后撤销，不改变用户的暂存区内容
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z'], cwd)
    .split('\0')
    .filter(
      (file) =>
        file && file !== 'node_modules' && !file.startsWith('node_modules/') && !file.startsWith('web/node_modules'),
    )
  if (untracked.length) git(['add', '--intent-to-add', '--', ...untracked], cwd)
  let numstat
  try {
    numstat = git(['diff', '--numstat', '--no-renames', base, '--'], cwd)
  } finally {
    if (untracked.length) git(['reset', '--quiet', '--', ...untracked], cwd)
  }
  const exists = (file) => {
    try {
      git(['cat-file', '-e', `${upstream}:${file}`], cwd)
      return true
    } catch {
      return false
    }
  }
  const result = { base, upstream, ...summarize(parseNumstat(numstat), exists) }
  if (json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  console.log(`upstream ${upstream.slice(0, 8)} · base ${base.slice(0, 8)}`)
  console.log(`upstream files touched: ${result.file_count} (+${result.added} -${result.deleted})`)
  for (const file of result.files)
    console.log(`  ${file.path}\t+${file.added}\t-${file.deleted}${file.binary ? '\tbinary' : ''}`)
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2))
