import { describe, expect, it, vi } from 'vitest'
import { accountRowsCsv, setAccountStatuses } from './account-actions'
import type { Resource } from './portal-model'

const row = (id: string, status = 'active'): Resource => ({
  id,
  name: id,
  status,
  vendor_id: 'supplier',
  resource_type: 'account',
  config: { platform: 'anthropic' },
  created_at: '2026-10-31T00:00:00Z',
})

describe('account batch state changes', () => {
  it.each(['active', 'paused'] as const)(
    'sets %s explicitly for every selected state',
    async (status) => {
      const rows = [
        row('already-active'),
        row('paused', 'paused'),
        row('preparing', 'provisioning'),
      ]
      const update = vi.fn().mockResolvedValue({})
      const progress = vi.fn()
      const result = await setAccountStatuses(rows, status, update, progress)
      expect(update.mock.calls).toEqual(rows.map((item) => [item, status]))
      expect(result).toEqual({
        succeeded: rows.map((item) => item.id),
        failed: [],
      })
      expect(progress.mock.calls).toEqual(
        rows.map((item, index) => [item, true, index + 1])
      )
    }
  )

  it('records each failure and continues without retrying or losing successful results', async () => {
    const rows = [row('first'), row('revoked-scope'), row('last')]
    const error = new Error('Permission revoked')
    const update = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({})
    const progress = vi.fn()
    expect(await setAccountStatuses(rows, 'paused', update, progress)).toEqual({
      succeeded: ['first', 'last'],
      failed: [{ id: 'revoked-scope', name: 'revoked-scope', error }],
    })
    expect(progress.mock.calls.map((call) => call.slice(1))).toEqual([
      [true, 1],
      [false, 2],
      [true, 3],
    ])
    expect(update).toHaveBeenCalledTimes(3)
  })

  it('waits for each write before starting the next one', async () => {
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const update = vi
      .fn()
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce({})
    const progress = vi.fn()
    const running = setAccountStatuses(
      [row('one'), row('two')],
      'active',
      update,
      progress
    )
    expect(update).toHaveBeenCalledTimes(1)
    expect(progress).not.toHaveBeenCalled()
    finish()
    await running
    expect(update).toHaveBeenCalledTimes(2)
    expect(progress).toHaveBeenCalledTimes(2)
  })
})

describe('selected account CSV', () => {
  it('exports only public summary columns with BOM, quotes, newlines and unknown values intact', () => {
    const selected = {
      ...row('chosen'),
      name: '账号,"quoted"\nsecond line',
      config: { platform: 'openai', access_token: 'DO-NOT-EXPORT-TOKEN' },
      proxy: { id: 'proxy', name: 'private', endpoint: 'DO-NOT-EXPORT-PROXY' },
    }
    const csv = accountRowsCsv([selected])
    expect(csv).toBe(
      '\uFEFF"id","name","platform","status","groups","today_usd","total_usd","created_at"\r\n' +
        '"chosen","账号,""quoted""\nsecond line","openai","","","","","2026-10-31T00:00:00Z"'
    )
    expect(csv).not.toContain('DO-NOT-EXPORT')
  })

  it.each([
    '=1+1',
    '+cmd',
    '-cmd',
    '@SUM(A1)',
    ' =1+1',
    '\t=1+1',
    '\r@cmd',
    '\n+cmd',
    '\tplain',
  ])('neutralizes a spreadsheet formula/control prefix %j', (name) => {
    expect(accountRowsCsv([{ ...row('selected'), name }])).toContain(
      `"'${name}"`
    )
  })
})
