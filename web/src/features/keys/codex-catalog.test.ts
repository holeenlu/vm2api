import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  catalogReasoningEffort,
  fetchCodexCatalog,
  modelCatalogUrl,
} from './codex-catalog'

afterEach(() => vi.unstubAllGlobals())
describe('authorized Codex catalog', () => {
  it('uses the protocol key and client_version without panel cookies or redirects', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          models: [{ slug: 'gpt-6.1-sol', supported_reasoning_levels: [] }],
        })
      )
    )
    vi.stubGlobal('fetch', fetcher)
    const result = await fetchCodexCatalog(
      'https://relay.example/prefix/v1/',
      'test-key'
    )
    expect(fetcher).toHaveBeenCalledWith(
      'https://relay.example/prefix/v1/models?client_version=0.156.0',
      expect.objectContaining({
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer test-key',
        },
        credentials: 'omit',
        redirect: 'error',
      })
    )
    expect(result.models[0].slug).toBe('gpt-6.1-sol')
    expect(result.content).not.toContain('test-key')
    expect(modelCatalogUrl('https://relay.example/V1/')).toBe(
      'https://relay.example/v1/models'
    )
  })
  it('keeps only OpenAI chat models in both the picker and downloaded JSON', async () => {
    const openai = [
      {
        slug: 'gpt-6.1-sol',
        model_messages: { instructions_template: 'Codex instructions' },
        default_reasoning_level: 'high',
        supported_reasoning_levels: [{ effort: 'high' }],
      },
      { slug: 'vendor/gpt-6-astra' },
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            models: [
              { slug: 'claude-sonnet-5-5' },
              ...openai,
              { slug: 'anthropic/claude-opus-5-5' },
              { slug: 'gpt-image-1' },
              { slug: 'custom-model' },
            ],
          })
        )
      )
    )
    const result = await fetchCodexCatalog('https://relay.example', 'test-key')
    expect(result.models).toEqual(openai)
    expect(JSON.parse(result.content).models).toEqual(openai)
    expect(result.content).not.toContain('claude-')
  })
  it('returns an empty Codex catalog when the group has only Claude models', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('{"models":[{"slug":"claude-sonnet-5-5"}]}')
        )
    )
    const result = await fetchCodexCatalog('https://relay.example', 'test-key')
    expect(result.models).toEqual([])
    expect(JSON.parse(result.content).models).toEqual([])
  })
  it('rejects an ordinary model list and authentication errors', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"data":[]}'))
      .mockResolvedValueOnce(new Response('', { status: 403 }))
    vi.stubGlobal('fetch', fetcher)
    await expect(
      fetchCodexCatalog('https://relay.example', 'test-key')
    ).rejects.toThrow('不是 Codex')
    await expect(
      fetchCodexCatalog('https://relay.example', 'test-key')
    ).rejects.toThrow('403')
  })
  it('takes reasoning from advertised metadata and does not invent a default', () => {
    expect(
      catalogReasoningEffort({
        slug: 'm',
        default_reasoning_level: 'high',
        supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
      })
    ).toBe('high')
    expect(
      catalogReasoningEffort({ slug: 'm', supported_reasoning_levels: [] })
    ).toBeNull()
    expect(
      catalogReasoningEffort({
        slug: 'm',
        default_reasoning_level: 'none',
        supported_reasoning_levels: [{ effort: 'none' }],
      })
    ).toBeNull()
  })
})
