import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyCrsUnofficialPersona } from '../../src/lib/identity/crs-persona.mjs'
import {
  canonicalPersonaCompat,
  DEFAULT_PERSONA_TEMPLATES,
  PERSONA_PRESETS,
  presetFlagEnabled,
  selectedTemplateBlocks,
  validatePersonaTemplate,
} from '../../src/lib/identity/persona-template.mjs'
import { profileForPreset } from '../../src/lib/identity/official-profiles.mjs'

function render(t, compatibility, system = 'CALLER_SENTINEL') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-current-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const routingFile = path.join(root, 'routing.json')
  fs.writeFileSync(routingFile, JSON.stringify({ compatibility }))
  return applyCrsUnofficialPersona(
    { model: 'claude-opus-5-5', system, messages: [{ role: 'user', content: 'USER_SENTINEL' }] },
    { routingFile },
  )
}

function userText(out) {
  const content = out.messages.find((message) => message.role === 'user')?.content
  return typeof content === 'string' ? content : (content || []).map((block) => block.text || '').join('')
}

test('current presets use 303 and retired selections preserve saved edits on official_full', () => {
  assert.deepEqual(PERSONA_PRESETS, ['official', 'official_full', 'zero', 'custom'])
  for (const preset of [...PERSONA_PRESETS, 'official_303'])
    assert.equal(profileForPreset(preset).cliVersion, preset === 'custom' ? '2.1.296' : '2.1.303')
  const template = [{ id: 'saved', type: 'text', text: 'USER_EDIT' }]
  const input = {
    persona_preset: 'official_303',
    persona_templates: { official_303: template },
    persona_guidance_presets: { official_303: true },
  }
  const copy = structuredClone(input)
  const next = canonicalPersonaCompat(input)
  assert.equal(next.persona_preset, 'official_full')
  assert.deepEqual(next.persona_templates, { official_full: template })
  assert.deepEqual(next.persona_guidance_presets, { official_full: true })
  assert.deepEqual(input, copy)
})

test('official_full keeps caller instructions once in the first user reminder and environment in message system', (t) => {
  const out = render(t, { persona_preset: 'official_full' })
  assert.equal(JSON.stringify(out.system).includes('CALLER_SENTINEL'), false)
  assert.equal(userText(out).split('CALLER_SENTINEL').length - 1, 1)
  assert.ok(userText(out).includes('USER_SENTINEL'))
  assert.ok(
    out.messages.some(
      (message) => message.role === 'system' && JSON.stringify(message.content).includes('# Environment'),
    ),
  )
  assert.match(out.system[0].text, /cc_version=2\.1\.303/)
  assert.match(out.system[1].text, /official CLI for Claude/)
})

test('zero keeps billing identity while leaving the user transcript unchanged', (t) => {
  const out = render(t, { persona_preset: 'zero' })
  assert.equal(out.system.length, 2)
  assert.match(out.system[0].text, /prompt_version=</)
  assert.equal(out.system[1].text, 'CALLER_SENTINEL')
  assert.deepEqual(out.messages, [{ role: 'user', content: 'USER_SENTINEL' }])
})

test('optional guidance, timezone, locale and long environment are opt-in', () => {
  for (const preset of PERSONA_PRESETS) {
    for (const flag of [
      'persona_guidance_presets',
      'persona_timezone_presets',
      'persona_locale_presets',
      'persona_env_instructions_presets',
    ]) {
      assert.equal(presetFlagEnabled({}, flag, preset), false)
      assert.equal(presetFlagEnabled({ [flag]: { [preset]: true } }, flag, preset), true)
    }
  }
  for (const preset of ['official', 'official_full']) {
    const blocks = DEFAULT_PERSONA_TEMPLATES[preset]
    assert.equal(
      selectedTemplateBlocks(blocks, {}, preset).some((block) => block.id === 'guidance'),
      false,
    )
    assert.equal(
      selectedTemplateBlocks(blocks, { persona_block_presets: { [preset]: { guidance: true } } }, preset).some(
        (block) => block.id === 'guidance',
      ),
      true,
    )
    assert.deepEqual(validatePersonaTemplate(blocks), [])
    assert.ok(blocks.some((block) => block.role === 'system' && block.text === '{{env_303}}'))
  }
})

test('environment opt-out removes generated environment while keeping the caller reminder', (t) => {
  const out = render(t, { persona_preset: 'official_full', persona_env_presets: { official_full: false } })
  assert.equal(
    out.messages.some((message) => message.role === 'system'),
    false,
  )
  assert.ok(userText(out).includes('CALLER_SENTINEL'))
})

for (const entrypoint of ['cli', 'sdk-cli'])
  test(`billing and identity use the saved ${entrypoint} entrypoint together`, (t) => {
    const out = render(t, { persona_preset: 'official_full', cc_entrypoint: entrypoint })
    assert.match(out.system[0].text, new RegExp(`cc_entrypoint=${entrypoint};`))
    assert.ok(out.system[1].text.includes('official CLI'))
  })

test('saved guidance switch reaches the actual request renderer, not just preview variables', (t) => {
  const off = render(t, { persona_preset: 'official_full' })
  const on = render(t, { persona_preset: 'official_full', persona_guidance_presets: { official_full: true } })
  assert.equal(JSON.stringify(off.system).includes('Write code that reads like'), false)
  assert.equal(JSON.stringify(on.system).includes('Write code that reads like'), true)
  assert.equal(userText(on).split('CALLER_SENTINEL').length - 1, 1)
})
