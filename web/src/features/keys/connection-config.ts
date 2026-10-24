import { t } from '@/i18n'
import {
  CODEX_CATALOG_PATH,
  isCodexModelId,
  modelCatalogUrl,
  type CatalogMode,
} from './codex-catalog'

export type Client = 'claude' | 'codex' | 'codex-ws' | 'opencode' | 'curl'
export type Shell = 'unix' | 'powershell' | 'cmd'
export type ConfigFile = {
  path: string
  content: string
  downloadName?: string
}
export function connectionClients(
  platform: string,
  websocket: boolean
): { id: Client; label: string }[] {
  return [
    ...(['anthropic', 'all'].includes(platform)
      ? [{ id: 'claude' as const, label: 'Claude Code' }]
      : []),
    ...(['openai', 'all'].includes(platform)
      ? [
          { id: 'codex' as const, label: 'Codex' },
          ...(websocket
            ? [{ id: 'codex-ws' as const, label: 'Codex WebSocket' }]
            : []),
        ]
      : []),
    { id: 'opencode', label: 'OpenCode' },
    { id: 'curl', label: t('keys:apiExample') },
  ]
}
export const shellQuote = (value: string) =>
  "'" + value.replace(/'/g, "'\\''") + "'"
export function connectionFiles({
  client,
  shell,
  base,
  key,
  model,
  platform,
  catalogMode = 'remote',
  reasoningEffort,
  standaloneSearch = false,
}: {
  client: Client
  shell: Shell
  base: string
  key: string
  model: string
  platform: string
  catalogMode?: CatalogMode
  reasoningEffort?: string | null
  standaloneSearch?: boolean
}): ConfigFile[] {
  if ((client === 'codex' || client === 'codex-ws') && !isCodexModelId(model))
    return []
  const v1 = modelCatalogUrl(base).replace(/[/]models$/, '')
  const root = v1.slice(0, -3)
  const home = shell === 'cmd' ? '%USERPROFILE%' : '~'
  const json = (v: unknown) => JSON.stringify(v, null, 2)
  const env = (values: Record<string, string>) =>
    Object.entries(values)
      .map(([k, v]) =>
        shell === 'unix'
          ? `export ${k}=${shellQuote(v)}`
          : shell === 'powershell'
            ? `$env:${k}='${v.replace(/'/g, "''")}'`
            : `set "${k}=${v.replace(/%/g, '%%').replace(/"/g, '')}"`
      )
      .join('\n')
  if (client === 'claude') {
    const vars = {
      ANTHROPIC_BASE_URL: root,
      ANTHROPIC_AUTH_TOKEN: key,
      ANTHROPIC_MODEL: model,
    }
    return [
      { path: t('keys:terminal'), content: env(vars) },
      {
        path: `${home}/.claude/settings.json`,
        content: json({ env: vars }),
        downloadName: 'settings.json',
      },
    ]
  }
  if (client === 'codex' || client === 'codex-ws')
    return [
      {
        path: `${home}/.codex/config.toml`,
        downloadName: 'config.toml',
        content: [
          '# API Key Mode',
          'model_provider = "tapmodels"',
          `model = ${json(model)}`,
          `review_model = ${json(model)}`,
          ...(reasoningEffort
            ? [`model_reasoning_effort = ${json(reasoningEffort)}`]
            : []),
          ...(catalogMode === 'file'
            ? [`model_catalog_json = ${json(CODEX_CATALOG_PATH)}`]
            : []),
          '',
          '[model_providers.tapmodels]',
          'name = "tapmodels"',
          `base_url = ${json(v1)}`,
          ...(catalogMode === 'remote'
            ? [`model_catalog_url = ${json(modelCatalogUrl(base))}`]
            : []),
          'wire_api = "responses"',
          'requires_openai_auth = false',
          `experimental_bearer_token = ${json(key)}`,
          `supports_websockets = ${client === 'codex-ws'}`,
          `supports_standalone_web_search = ${standaloneSearch}`,
          '',
          '[features]',
          ...(catalogMode === 'remote'
            ? ['api_key_model_discovery = true']
            : []),
          ...(client === 'codex-ws' ? ['responses_websockets_v2 = true'] : []),
          'goals = true',
          `standalone_web_search = ${standaloneSearch}`,
          '',
        ].join('\n'),
      },
    ]
  if (client === 'opencode')
    return [
      {
        path: 'opencode.json',
        downloadName: 'opencode.json',
        content: json({
          $schema: 'https://opencode.ai/config.json',
          model: `tapmodels/${model}`,
          provider: {
            tapmodels: {
              npm:
                platform === 'anthropic'
                  ? '@ai-sdk/anthropic'
                  : '@ai-sdk/openai-compatible',
              name: 'tapmodels',
              options: { baseURL: v1, apiKey: key },
              models: { [model]: { name: model } },
            },
          },
        }),
      },
    ]
  const anthropic = platform === 'anthropic'
  const payload = anthropic
    ? { model, max_tokens: 64, messages: [{ role: 'user', content: 'Hello' }] }
    : { model, input: 'Hello' }
  const url = v1 + (anthropic ? '/messages' : '/responses')
  const header = `Authorization: Bearer ${key}`
  if (shell === 'powershell')
    return [
      {
        path: 'PowerShell',
        content: `Invoke-RestMethod -Uri '${url.replace(/'/g, "''")}' -Method Post -Headers @{Authorization='Bearer ${key}'} -ContentType 'application/json' -Body '${JSON.stringify(payload).replace(/'/g, "''")}'`,
      },
    ]
  if (shell === 'cmd')
    return [
      {
        path: 'CMD',
        content: `curl.exe "${url}" -H "${header}" -H "Content-Type: application/json" --data "${JSON.stringify(payload).replace(/"/g, '\\"')}"`,
      },
    ]
  return [
    {
      path: t('keys:terminal'),
      content: `curl ${shellQuote(url)} \\\n  -H ${shellQuote(header)} \\\n  -H 'Content-Type: application/json' \\\n  --data ${shellQuote(JSON.stringify(payload))}`,
    },
  ]
}
