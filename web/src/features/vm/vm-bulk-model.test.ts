import { describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import {
  appliesTo,
  bulkBase,
  bulkComplete,
  groupResult,
  saveBulk,
  type BulkReport,
  type BulkRequest,
  type BulkTarget,
} from './vm-bulk-model'

vi.mock('@/lib/api', () => ({ api: vi.fn() }))
const report: BulkReport = {
  operation_id: 'op',
  status: 'complete',
  items: [{ id: 'vm-1', fields: { weight: { status: 'saved' } } }],
}
const request = {
  operation_id: 'op',
  items: [],
  patch: { weight: 2 },
  confirm_empty_groups: false,
} as BulkRequest

describe('VM bulk save contract', () => {
  it('distinguishes group add/remove/replace including intentional empty replacement', () => {
    expect(groupResult([1, 2], [2, 3], 'add')).toEqual([1, 2, 3])
    expect(groupResult([1, 2], [2], 'remove')).toEqual([1])
    expect(groupResult([1, 2], [], 'replace')).toEqual([])
  })
  it('keeps GPT weights and Claude levels separate for mixed selections', () => {
    const gpt = { platform: 'openai' } as BulkTarget,
      claude = { platform: 'anthropic' } as BulkTarget
    expect(appliesTo('weight', gpt)).toBe(true)
    expect(appliesTo('weight', claude)).toBe(false)
    expect(appliesTo('schedule_level', gpt)).toBe(false)
    expect(appliesTo('max_concurrency', claude)).toBe(true)
  })
  it('does not mistake HTTP success or a partial report for durable completion', () => {
    expect(bulkComplete(report)).toBe(true)
    expect(bulkComplete({ ...report, status: 'incomplete' })).toBe(false)
    expect(
      bulkComplete({
        ...report,
        items: [{ id: 'vm-1', fields: { weight: { status: 'writing' } } }],
      })
    ).toBe(false)
    expect(bulkComplete({ ...report, items: [] })).toBe(false)
  })
  it('a successful save only needs one write request', async () => {
    vi.mocked(api).mockReset().mockResolvedValueOnce(report)
    expect(await saveBulk(request)).toEqual(report)
    expect(api).toHaveBeenCalledTimes(1)
    expect(api).toHaveBeenCalledWith(bulkBase, {
      method: 'POST',
      body: JSON.stringify(request),
    })
  })
  it('queries the same operation after a lost response, without replaying writes', async () => {
    vi.mocked(api)
      .mockReset()
      .mockRejectedValueOnce(new Error('lost response'))
      .mockResolvedValueOnce(report)
    expect(await saveBulk(request)).toEqual(report)
    expect(api).toHaveBeenLastCalledWith(`${bulkBase}/operations/op`)
    expect(api).toHaveBeenCalledTimes(2)
  })
  it('retains the original error when neither write nor receipt can be confirmed', async () => {
    const error = new Error('network failure')
    vi.mocked(api)
      .mockReset()
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(new Error('not found'))
    await expect(saveBulk(request)).rejects.toBe(error)
  })
})
