import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  connectionClients,
  connectionFiles,
  shellQuote,
} from './connection-config'

const input = {
  shell: 'unix' as const,
  base: 'https://relay.example/prefix/v1/',
  key: 'test-key',
  model: 'claude-sonnet-5-5',
  platform: 'anthropic',
}
describe('client connection configuration', () => {
  it.each([
    ['anthropic', true, ['claude', 'opencode', 'curl']],
    ['openai', true, ['codex', 'codex-ws', 'opencode', 'curl']],
    ['all', true, ['claude', 'codex', 'codex-ws', 'opencode', 'curl']],
    ['all', false, ['claude', 'codex', 'opencode', 'curl']],
  ] as const)(
    'selects clients and the default for %s, websocket=%s',
    (platform, websocket, expected) => {
      expect(connectionClients(platform, websocket).map((c) => c.id)).toEqual(
        expected
      )
    }
  )
  it('offers downloads for configuration files, while shell commands are copy-only', () => {
    for (const shell of ['unix', 'powershell', 'cmd'] as const) {
      const claude = connectionFiles({ ...input, shell, client: 'claude' })
      expect(claude.map((f) => f.downloadName)).toEqual([
        undefined,
        'settings.json',
      ])
      expect(
        connectionFiles({ ...input, shell, client: 'curl' })[0].downloadName
      ).toBeUndefined()
      expect(
        connectionFiles({
          ...input,
          shell,
          client: 'codex',
          model: 'gpt-6.1-sol',
        })[0].downloadName
      ).toBe('config.toml')
      expect(
        connectionFiles({ ...input, shell, client: 'opencode' })[0].downloadName
      ).toBe('opencode.json')
    }
  })
  it('Claude uses root base while retaining deployment prefixes', () => {
    const files = connectionFiles({ ...input, client: 'claude' })
    expect(JSON.parse(files[1].content).env.ANTHROPIC_BASE_URL).toBe(
      'https://relay.example/prefix'
    )
    expect(files[0].content).toContain("ANTHROPIC_AUTH_TOKEN='test-key'")
  })
  it('Codex generates a complete standalone API Key Mode config', () => {
    const files = connectionFiles({
      ...input,
      client: 'codex',
      platform: 'openai',
      model: 'gpt-6.1-sol',
    })
    expect(files).toHaveLength(1)
    expect(files[0].content).toContain(
      'base_url = "https://relay.example/prefix/v1"'
    )
    expect(files[0].content).toContain('wire_api = "responses"')
    expect(files[0].content).toContain('experimental_bearer_token = "test-key"')
    expect(files[0].content).not.toContain('env_key')
    expect(files[0].content).toContain('supports_websockets = false')
    expect(files[0].content.split('\n')[0]).toBe('# API Key Mode')
    expect(files[0].content).toContain('model_provider = "tapmodels"')
    expect(files[0].content).not.toContain('vm2api')
  })
  it.each(['codex', 'codex-ws'] as const)(
    '%s parses as TOML with catalog fields in the correct tables',
    (client) => {
      for (const catalogMode of ['remote', 'file'] as const) {
        for (const shell of ['unix', 'cmd', 'powershell'] as const) {
          const key = 'test-key"with\\quotes\nand-unicode-中文'
          const file = connectionFiles({
            ...input,
            model: 'gpt-6.1-sol',
            platform: 'openai',
            client,
            catalogMode,
            shell,
            key,
            reasoningEffort: 'high',
            standaloneSearch: true,
          })[0]
          const config = JSON.parse(
            execFileSync(
              'python3',
              [
                '-c',
                'import sys,tomllib,json; print(json.dumps(tomllib.loads(sys.stdin.read())))',
              ],
              { input: file.content, encoding: 'utf8' }
            )
          )
          expect(config.model).toBe('gpt-6.1-sol')
          expect(config.review_model).toBe('gpt-6.1-sol')
          expect(config.model_reasoning_effort).toBe('high')
          expect(
            config.model_providers.tapmodels.experimental_bearer_token
          ).toBe(key)
          expect(config.model_providers.tapmodels.requires_openai_auth).toBe(
            false
          )
          expect(config.model_providers.tapmodels.env_key).toBeUndefined()
          expect(config.model_providers.tapmodels.supports_websockets).toBe(
            client === 'codex-ws'
          )
          expect(config.features.responses_websockets_v2).toBe(
            client === 'codex-ws' ? true : undefined
          )
          expect(config.model_catalog_json).toBe(
            catalogMode === 'file' ? '~/.codex/codex-models.json' : undefined
          )
          expect(config.model_providers.tapmodels.model_catalog_url).toBe(
            catalogMode === 'remote'
              ? 'https://relay.example/prefix/v1/models'
              : undefined
          )
          expect(config.features.api_key_model_discovery).toBe(
            catalogMode === 'remote' ? true : undefined
          )
        }
      }
    }
  )
  it.each(['codex', 'codex-ws'] as const)(
    '%s does not generate a config for a Claude or unsupported model',
    (client) => {
      for (const model of [
        'claude-sonnet-5-5',
        'anthropic/claude-opus-5-5',
        'gpt-image-1',
        'custom-model',
        '',
      ]) {
        expect(connectionFiles({ ...input, client, model })).toEqual([])
      }
    }
  )
  it('OpenCode config parses and uses selected model', () => {
    const file = connectionFiles({ ...input, client: 'opencode' })[0]
    expect(
      JSON.parse(file.content).provider.tapmodels.models[input.model]
    ).toBeDefined()
  })
  it('shell configuration quotes untrusted model or URL content instead of executing it', () => {
    expect(shellQuote("a'$(cmd)")).toBe("'a'\\''$(cmd)'")
    const file = connectionFiles({
      ...input,
      client: 'curl',
      model: "test'$(cmd)",
    })[0]
    expect(file.content).toContain("test'\\''$(cmd)")
  })
})
