import type { PanelUser } from '@/types/panel-users'
import { describe, expect, it } from 'vitest'
import { userTreeRows } from './hierarchy'

const user = (id: string, parent: string | null = null): PanelUser => ({
  id,
  username: id,
  role: 'user',
  enabled: true,
  parent_user_id: parent,
})

const shape = (rows: ReturnType<typeof userTreeRows>) =>
  rows.map((r) => `${'-'.repeat(r.depth)}${r.user.id}:${r.children}`)

describe('userTreeRows', () => {
  const items = [
    user('root'),
    user('vendor', 'root'),
    user('acme', 'root'),
    user('joey', 'acme'),
    user('tony', 'acme'),
    user('ting', 'tony'),
    user('client', 'acme'),
  ]

  it('orders users depth-first under their creator', () => {
    expect(shape(userTreeRows(items))).toEqual([
      'root:2',
      '-vendor:0',
      '-acme:3',
      '--joey:0',
      '--tony:1',
      '---ting:0',
      '--client:0',
    ])
  })

  it('treats users whose creator is not visible as roots', () => {
    expect(shape(userTreeRows(items.slice(3)))).toEqual([
      'joey:0',
      'tony:1',
      '-ting:0',
      'client:0',
    ])
  })

  it('hides every descendant of a collapsed user', () => {
    expect(shape(userTreeRows(items, new Set(['acme'])))).toEqual([
      'root:2',
      '-vendor:0',
      '-acme:3',
    ])
  })

  it('keeps users in a broken parent cycle exactly once', () => {
    const rows = userTreeRows([user('a', 'b'), user('b', 'a'), user('c')])
    expect(rows.map((r) => r.user.id).sort()).toEqual(['a', 'b', 'c'])
  })
})
