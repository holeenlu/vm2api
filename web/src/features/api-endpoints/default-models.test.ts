import { describe, expect, it } from 'vitest'
import { hasModelDraftContent, systemOpenAiModels } from './default-models'

describe('OpenAI endpoint default models', () => {
  it('uses the enabled system policy models and removes duplicate ids', () => {
    const models = systemOpenAiModels({
      effective: [{ id: 'gpt-5.4' }, { id: 'GPT-5.4' }],
      models: [{ id: 'gpt-disabled', enabled: false }],
    })
    expect(models).toEqual([{ name: 'gpt-5.4', alias: 'gpt-5.4' }])
  })

  it('does not replace a model draft that already contains user input', () => {
    expect(hasModelDraftContent([{ name: '', alias: '' }])).toBe(false)
    expect(hasModelDraftContent([{ name: 'gpt-5.4', alias: '' }])).toBe(true)
  })
})
