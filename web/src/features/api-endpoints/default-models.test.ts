import type { ApiModelEntry } from '@/types/panel-api-endpoints'
import { describe, expect, it } from 'vitest'
import {
  appendSystemModels,
  hasModelDraftContent,
  systemEndpointModels,
} from './default-models'

const image = (id: string, enabled = true) => ({
  id,
  enabled,
  display_name: id,
  snapshots: [],
  upstream_default: false,
  sort: 1,
})

describe('official endpoint default models', () => {
  it('includes enabled OpenAI chat and image models, without duplicates or snapshots', () => {
    expect(
      systemEndpointModels('openai', {
        models: [
          { id: 'gpt-6-astra' },
          { id: 'GPT-6-ASTRA' },
          { id: 'disabled', enabled: false },
        ],
        image_tools: [
          image('gpt-image-2.5-flare'),
          image('gpt-image-2.5-sunburst', false),
        ],
      })
    ).toEqual([
      { name: 'gpt-6-astra', alias: 'gpt-6-astra' },
      {
        name: 'gpt-image-2.5-flare',
        alias: 'gpt-image-2.5-flare',
        image: true,
      },
    ])
  })

  it('uses the Claude whitelist independently of the available VM catalog', () => {
    expect(
      systemEndpointModels('claude', {
        models: [
          { id: 'claude-fable-5-1' },
          { id: 'claude-disabled', enabled: false },
        ],
        effective: [],
        image_tools: [image('gpt-image-2.5-flare')],
      })
    ).toEqual([{ name: 'claude-fable-5-1', alias: 'claude-fable-5-1' }])
  })

  it('does not populate custom endpoints or revive an explicitly empty whitelist', () => {
    expect(systemEndpointModels('custom', { models: [{ id: 'x' }] })).toEqual(
      []
    )
    expect(
      systemEndpointModels('claude', { models: [], effective: [{ id: 'x' }] })
    ).toEqual([])
    expect(systemEndpointModels('openai', undefined)).toEqual([])
  })

  it('can fall back to an effective catalog when policy rows are absent', () => {
    expect(
      systemEndpointModels('openai', { effective: [{ id: ' gpt-6-astra ' }] })
    ).toEqual([{ name: 'gpt-6-astra', alias: 'gpt-6-astra' }])
  })

  it('appends missing whitelist entries without overwriting custom names or aliases', () => {
    const draft: ApiModelEntry[] = [
      {
        name: 'upstream-name',
        alias: 'gpt-6-astra',
        thinking: { levels: ['high'] },
        image: false,
      },
    ]
    const defaults = systemEndpointModels('openai', {
      models: [{ id: 'gpt-6-astra' }],
      image_tools: [image('gpt-image-2.5-flare')],
    })
    expect(appendSystemModels(draft, defaults)).toEqual([draft[0], defaults[1]])
    expect(
      appendSystemModels(appendSystemModels(draft, defaults), defaults)
    ).toHaveLength(2)
  })

  it('does not replace a model draft that already contains user input', () => {
    expect(hasModelDraftContent([{ name: '', alias: '' }])).toBe(false)
    expect(hasModelDraftContent([{ name: 'gpt-6-astra', alias: '' }])).toBe(
      true
    )
  })
})
