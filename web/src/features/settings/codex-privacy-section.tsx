import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { EyeOff } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { PaneSection } from './scheduler-controls'

type PrivacyPolicy = {
  enabled: boolean
  onError: 'skip_rule' | 'reject_request'
  rules: unknown[]
}
type Outcome = {
  ruleId: string
  matches: number
  status: string
  reason?: string
}
type PreviewResult = {
  result: {
    body: unknown
    headers: Record<string, string[]>
    outcomes: Outcome[]
  }
}

const PRIVACY_KEY = ['codex-privacy']
const STATUS_LABELS: Record<string, string> = {
  applied: 'codexPrivacy.statusApplied',
  unmatched: 'codexPrivacy.statusUnmatched',
  skipped: 'codexPrivacy.statusSkipped',
  disabled: 'codexPrivacy.statusDisabled',
}
const SELECT = 'h-9 w-full rounded border bg-background px-2 text-sm'
const RULES_EXAMPLE = `[
  {
    "id": "home-path",
    "name": "隐藏主目录",
    "enabled": true,
    "steps": [
      {
        "scope": "request_body",
        "selector": "$.input[*].content[*].text",
        "action": "regex_replace",
        "pattern": "/Users/[^/\\\\s]+",
        "replacement": "~",
        "replaceAll": true
      }
    ]
  }
]`

function parseJSON<T>(text: string): { value?: T; error?: string } {
  try {
    return { value: JSON.parse(text) as T }
  } catch (error) {
    return { error: (error as Error).message }
  }
}

// Gateway Worker 隐私规则：发送前按顺序改写 turn metadata、Desktop Git 上下文、环境文本、正文与请求头。
export function CodexPrivacySection() {
  const { t } = useTranslation('settings')
  const queryClient = useQueryClient()
  const setting = useQuery({
    queryKey: PRIVACY_KEY,
    queryFn: () => api<{ policy: PrivacyPolicy }>('/api/panel/codex-privacy'),
  })
  const [enabled, setEnabled] = useState(false)
  const [onError, setOnError] = useState<PrivacyPolicy['onError']>('skip_rule')
  const [rules, setRules] = useState('[]')
  const [sample, setSample] = useState(
    '{"input":[{"role":"user","content":[{"type":"input_text","text":"cd /Users/alice/project"}]}]}'
  )
  const [sampleHeaders, setSampleHeaders] = useState('{}')
  const [result, setResult] = useState<PreviewResult['result'] | null>(null)
  useEffect(() => {
    const policy = setting.data?.policy
    if (!policy) return
    setEnabled(policy.enabled)
    setOnError(policy.onError)
    setRules(JSON.stringify(policy.rules, null, 2))
  }, [setting.data])
  const parsedRules = parseJSON<unknown[]>(rules)
  const policy = () => ({
    enabled,
    onError,
    rules: Array.isArray(parsedRules.value) ? parsedRules.value : [],
  })
  const previewMutation = useMutation({
    mutationFn: () => {
      const body = parseJSON(sample)
      const headers = parseJSON<Record<string, string[]>>(sampleHeaders)
      if (body.error || headers.error)
        throw new Error(t('codexPrivacy.invalidSample'))
      return api<PreviewResult>('/api/panel/codex-privacy/preview', {
        method: 'POST',
        body: JSON.stringify({
          policy: { ...policy(), enabled: true },
          body: body.value,
          headers: headers.value,
        }),
      })
    },
    onSuccess: (data) => setResult(data.result),
    onError: (error: Error) => {
      setResult(null)
      toast.error(error.message)
    },
  })
  const save = useMutation({
    mutationFn: () =>
      api('/api/panel/codex-privacy', {
        method: 'PUT',
        body: JSON.stringify({ policy: policy() }),
      }),
    onSuccess: async () => {
      toast.success(t('codexPrivacy.saved'))
      await queryClient.invalidateQueries({ queryKey: PRIVACY_KEY })
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const busy = setting.isLoading || save.isPending
  const rulesInvalid = !!parsedRules.error || !Array.isArray(parsedRules.value)
  return (
    <PaneSection
      icon={EyeOff}
      title={t('codexPrivacy.title')}
      desc={t('codexPrivacy.help')}
    >
      <div className='flex items-center justify-between gap-3'>
        <Label htmlFor='codex-privacy-enabled'>
          {t('codexPrivacy.enabled')}
        </Label>
        <Switch
          id='codex-privacy-enabled'
          checked={enabled}
          disabled={busy}
          onCheckedChange={setEnabled}
        />
      </div>
      <Label className='flex flex-col items-start gap-2'>
        {t('codexPrivacy.onError')}
        <select
          className={SELECT}
          disabled={busy}
          value={onError}
          onChange={(event) =>
            setOnError(event.target.value as PrivacyPolicy['onError'])
          }
        >
          <option value='skip_rule'>{t('codexPrivacy.skipRule')}</option>
          <option value='reject_request'>
            {t('codexPrivacy.rejectRequest')}
          </option>
        </select>
      </Label>
      <Label
        htmlFor='codex-privacy-rules'
        className='flex flex-col items-start gap-2'
      >
        {t('codexPrivacy.rules')}
        <Textarea
          id='codex-privacy-rules'
          className='min-h-48 font-mono text-xs'
          disabled={busy}
          value={rules}
          placeholder={RULES_EXAMPLE}
          aria-invalid={rulesInvalid}
          onChange={(event) => setRules(event.target.value)}
        />
        <span className='text-xs text-muted-foreground'>
          {rulesInvalid
            ? t('codexPrivacy.invalidRules')
            : t('codexPrivacy.rulesHelp')}
        </span>
      </Label>
      <div className='grid gap-3 sm:grid-cols-2'>
        <Label className='flex flex-col items-start gap-2'>
          {t('codexPrivacy.sampleBody')}
          <Textarea
            className='min-h-24 font-mono text-xs'
            value={sample}
            onChange={(event) => setSample(event.target.value)}
          />
        </Label>
        <Label className='flex flex-col items-start gap-2'>
          {t('codexPrivacy.sampleHeaders')}
          <Textarea
            className='min-h-24 font-mono text-xs'
            value={sampleHeaders}
            placeholder='{"x-codex-turn-metadata":["{\"workspace\":\"/Users/alice\"}"]}'
            onChange={(event) => setSampleHeaders(event.target.value)}
          />
        </Label>
      </div>
      <div className='flex flex-wrap gap-2'>
        <Button
          variant='outline'
          size='sm'
          disabled={busy || rulesInvalid || previewMutation.isPending}
          onClick={() => previewMutation.mutate()}
        >
          {t('codexPrivacy.preview')}
        </Button>
        <Button
          size='sm'
          disabled={busy || rulesInvalid}
          onClick={() => save.mutate()}
        >
          {t('codexPrivacy.save')}
        </Button>
      </div>
      {result ? (
        <div className='space-y-2 rounded border bg-muted/30 p-3 text-xs'>
          <ul className='space-y-1'>
            {result.outcomes.map((outcome) => (
              <li key={outcome.ruleId}>
                <span className='font-mono'>{outcome.ruleId}</span>:{' '}
                {STATUS_LABELS[outcome.status]
                  ? t(STATUS_LABELS[outcome.status])
                  : outcome.status}
                {outcome.matches ? ` × ${outcome.matches}` : ''}
                {outcome.reason ? ` (${outcome.reason})` : ''}
              </li>
            ))}
          </ul>
          <pre className='overflow-x-auto font-mono break-all whitespace-pre-wrap'>
            {JSON.stringify(result.body, null, 2)}
          </pre>
          {Object.keys(result.headers).length ? (
            <pre className='overflow-x-auto font-mono break-all whitespace-pre-wrap'>
              {JSON.stringify(result.headers, null, 2)}
            </pre>
          ) : null}
        </div>
      ) : null}
    </PaneSection>
  )
}
