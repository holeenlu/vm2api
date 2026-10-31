import { describe, expect, it } from 'vitest'
import {
  DEFAULT_AGENT_STANDING,
  DEFAULT_PERSONA_TEMPLATES,
  EMPTY_BLOCK_TEXT,
  PERSONA_PRESETS,
  agentStandingVar,
  applyPersonaEnvVars,
  dropLegacyAutoScope,
  overlayDisabledByPersona,
  personaInjectFromPreset,
  presetSeed,
  personaHideEnabled,
  presetFlagEnabled,
  previewModelSentence,
  previewSystemBlocks,
  setPersonaHide,
  setPresetFlag,
  templateSlotState,
  templateOrFollowPreset,
  validatePersonaTemplate,
} from './persona-template'

describe('persona template contract', () => {
  it('forces overlay off only for zero, and empty custom seeds official', () => {
    expect(overlayDisabledByPersona('zero')).toBe(true)
    expect(overlayDisabledByPersona('official')).toBe(false)
    expect(presetSeed(DEFAULT_PERSONA_TEMPLATES, 'custom')).toEqual(
      DEFAULT_PERSONA_TEMPLATES.official
    )
    expect(
      templateOrFollowPreset(
        DEFAULT_PERSONA_TEMPLATES.zero,
        DEFAULT_PERSONA_TEMPLATES,
        'zero'
      )
    ).toEqual([])
    expect(validatePersonaTemplate(DEFAULT_PERSONA_TEMPLATES.zero)).toEqual([])
  })

  it('writes the three persona switches back as their own inject values', () => {
    expect(personaInjectFromPreset('official', 'rewrite')).toBe(
      'official_prompt'
    )
    expect(personaInjectFromPreset('official_full', 'rewrite')).toBe(
      'official_full'
    )
    expect(personaInjectFromPreset('zero', 'rewrite')).toBe('zero')
    expect(personaInjectFromPreset('official_full', 'rewrite')).toBe(
      'official_full'
    )
    expect(personaInjectFromPreset('custom', 'append')).toBe('append')
  })
})

describe('agent standing + system preview', () => {
  const vars = {
    identity: 'ID',
    identity_cli: 'ID',
    reporting: 'REPORTING',
    dynamic_boundary: 'BOUNDARY',
    agent_official: 'AGENT',
    env_official: 'ENV',
    caller_agent: '',
    caller_system: '',
  }

  it('keeps standing default off while explicit true stays enabled', () => {
    for (const key of PERSONA_PRESETS) {
      expect(presetFlagEnabled({}, 'agent_standing_presets', key)).toBe(false)
      expect(agentStandingVar({}, key)).toBe('')
    }
    expect(
      agentStandingVar(
        { agent_standing_presets: { official: true } },
        'official'
      )
    ).toBe(`${DEFAULT_AGENT_STANDING}\n`)
    expect(
      agentStandingVar({ agent_standing_presets: { official: true } }, 'zero')
    ).toBe('')
    expect(
      agentStandingVar(
        { agent_standing: '', agent_standing_presets: { official: true } },
        'official'
      )
    ).toBe('')
    expect(
      agentStandingVar({ agent_standing_presets: { zero: false } }, 'zero')
    ).toBe('')
  })

  it('keeps env and standing-hide flags default on', () => {
    for (const key of PERSONA_PRESETS) {
      expect(presetFlagEnabled({}, 'persona_env_presets', key)).toBe(true)
      expect(presetFlagEnabled({}, 'agent_standing_hide_presets', key)).toBe(
        true
      )
    }
  })

  it('zero preview contains no injected prompt even when standing text is provided', () => {
    expect(
      previewSystemBlocks(DEFAULT_PERSONA_TEMPLATES.zero, {
        ...vars,
        agent_standing: 'constraint',
      })
    ).toEqual([])
  })

  it('saved custom blocks still retain explicit standing content and cache metadata', () => {
    const out = previewSystemBlocks(
      [
        {
          id: 'saved',
          type: 'text',
          text: '{{agent_standing}}',
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ],
      { agent_standing: 'Stay terse.' }
    )
    expect(out[0]).toMatchObject({
      text: 'Stay terse.',
      ttl: '1h',
      placeholder: false,
    })
  })

  it('keeps required blank blocks as zero-width placeholders', () => {
    const blocks = previewSystemBlocks(
      [{ id: 'agent_slot', type: 'text', text: '{{agent_standing}}' }],
      { agent_standing: '' }
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({
      id: 'agent_slot',
      text: EMPTY_BLOCK_TEXT,
      placeholder: true,
    })
  })

  it('reports whether a template can switch standing / env', () => {
    const full = DEFAULT_PERSONA_TEMPLATES.official_full
    expect(templateSlotState(full, 'agent_standing')).toBe('switch')
    expect(templateSlotState(full, 'env')).toBe('switch')
    expect(templateSlotState(DEFAULT_PERSONA_TEMPLATES.zero, 'env')).toBe(
      'absent'
    )
    expect(templateSlotState([], 'env')).toBe('absent')
    expect(templateSlotState(DEFAULT_PERSONA_TEMPLATES.official, 'env')).toBe(
      'switch'
    )
    expect(
      templateSlotState(
        [{ type: 'text', text: '{{env_timezone_only}}' }],
        'env'
      )
    ).toBe('switch')
    expect(
      templateSlotState([{ type: 'text', text: '{{timezone}}' }], 'env')
    ).toBe('switch')
    expect(
      templateSlotState(
        [{ type: 'text', text: '# Environment\n - Timezone: UTC' }],
        'env'
      )
    ).toBe('absent')
  })
  it('keeps the model sentence off until the preset switch is enabled', () => {
    const edited = {
      model_env_extra: {
        'claude-sonnet-5-5': 'Sonnet extra.',
        'claude-haiku-5-5': 'Haiku extra.',
      },
    }
    const on = {
      ...edited,
      model_env_extra_presets: { official_full: true },
    }
    const block = (model: string, compat: Record<string, unknown>) =>
      previewSystemBlocks(DEFAULT_PERSONA_TEMPLATES.official_full, {
        model_sentence: previewModelSentence(compat, model, 'official_full'),
      }).find((item) => item.id === 'env_extra')
    expect(block('claude-sonnet-5-5', edited)).toBeUndefined()
    expect(block('claude-sonnet-5-5', on)?.text).toBe('Sonnet extra.')
    expect(block('claude-haiku-5-5', on)?.text).toBe('Haiku extra.')
    expect(block('claude-opus-5-5', on)).toBeUndefined()
  })

  it('environment opt-out clears generated macros without removing authored literals or caller text', () => {
    const next = applyPersonaEnvVars(
      { env_303: 'GENERATED', env_timezone: 'UTC', caller_system: 'CALLER' },
      { persona_env_presets: { official_full: false } },
      'official_full'
    )
    expect(next).toMatchObject({
      env_303: '',
      env_timezone: '',
      caller_system: 'CALLER',
    })
    expect(
      previewSystemBlocks([{ id: 'literal', text: 'AUTHORED ENV' }], next)[0]
        .text
    ).toBe('AUTHORED ENV')
  })

  it('native harness retains its global scope while custom blocks retain their explicit cache metadata', () => {
    const native = previewSystemBlocks(
      DEFAULT_PERSONA_TEMPLATES.official_full,
      { harness_303: 'HARNESS' }
    )
    expect(native.find((block) => block.id === 'harness')).toMatchObject({
      text: 'HARNESS',
      scope: 'global',
    })
    expect(
      previewSystemBlocks(
        [
          {
            id: 'custom',
            text: 'CUSTOM',
            cache_control: { type: 'ephemeral', ttl: '1h', scope: 'org' },
          },
        ],
        {}
      )[0]
    ).toMatchObject({ ttl: '1h', scope: 'org' })
  })
  it('toggle map is removed only when values match the field default', () => {
    const off = setPresetFlag({}, 'persona_env_presets', 'zero', false, {})
    expect(off.persona_env_presets).toEqual({
      official: true,
      official_full: true,
      zero: false,
      custom: true,
    })
    const back = setPresetFlag(off, 'persona_env_presets', 'zero', true, {})
    expect('persona_env_presets' in back).toBe(false)
    const serverHad = setPresetFlag(off, 'persona_env_presets', 'zero', true, {
      persona_env_presets: { zero: false },
    })
    expect(serverHad.persona_env_presets).toMatchObject({ zero: true })

    const standingOn = setPresetFlag(
      {},
      'agent_standing_presets',
      'official',
      true,
      {}
    )
    expect(standingOn.agent_standing_presets).toEqual({
      official: true,
      official_full: false,
      zero: false,
      custom: false,
    })
    expect(agentStandingVar(standingOn, 'official')).toBe(
      `${DEFAULT_AGENT_STANDING}\n`
    )
    expect(agentStandingVar(standingOn, 'zero')).toBe('')
    const standingOff = setPresetFlag(
      standingOn,
      'agent_standing_presets',
      'official',
      false,
      {}
    )
    expect('agent_standing_presets' in standingOff).toBe(false)

    const serverStanding = setPresetFlag(
      {},
      'agent_standing_presets',
      'official',
      false,
      { agent_standing_presets: { official: true } }
    )
    expect(serverStanding.agent_standing_presets).toEqual({
      official: false,
      official_full: false,
      zero: false,
      custom: false,
    })
  })

  it('explicit preset usage masks override the legacy value and billing-only zero is not implicitly masked', () => {
    expect(personaHideEnabled({}, 'zero', DEFAULT_PERSONA_TEMPLATES.zero)).toBe(
      true
    )
    expect(
      personaHideEnabled(
        { persona_hides: true, persona_hide_presets: { official: false } },
        'official',
        DEFAULT_PERSONA_TEMPLATES.official
      )
    ).toBe(false)
    const on = setPersonaHide(
      {},
      'zero',
      true,
      DEFAULT_PERSONA_TEMPLATES.zero,
      {}
    )
    expect(on.persona_hide_presets).toBeUndefined()
    expect(
      setPersonaHide(on, 'zero', false, DEFAULT_PERSONA_TEMPLATES.zero, {})
        .persona_hide_presets
    ).toEqual({ zero: false })
  })
})

describe('legacy global cache scope', () => {
  const legacy = { type: 'ephemeral', ttl: '1h', scope: 'global' }
  it('saved legacy agent blocks drop their obsolete scope without changing native harness scope', () => {
    const legacy = [
      {
        id: 'agent_official',
        text: 'SAVED',
        cache_control: { type: 'ephemeral', ttl: '1h', scope: 'global' },
      },
    ]
    expect(
      previewSystemBlocks(dropLegacyAutoScope('official_full', legacy), {})[0]
    ).toMatchObject({ text: 'SAVED', ttl: '1h', scope: '' })
  })
  it('keeps custom presets and other explicit scopes', () => {
    const custom = [
      { id: 'agent', type: 'text', text: 'x', cache_control: legacy },
    ]
    expect(dropLegacyAutoScope('custom', custom)).toEqual(custom)
    const explicit = [
      {
        id: 'agent_official',
        type: 'text',
        text: 'x',
        cache_control: { type: 'ephemeral', ttl: '5m', scope: 'global' },
      },
    ]
    expect(dropLegacyAutoScope('official_full', explicit)).toEqual(explicit)
  })
})
