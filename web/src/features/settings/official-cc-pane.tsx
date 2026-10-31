import { t as translate } from '@/i18n'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'

type OfficialCcConfig = Record<string, unknown>

function getTimeouts(): [number, string][] {
  return [
    [30000, translate('settings:duration.thirtySeconds')],
    [60000, translate('settings:duration.oneMinute')],
    [120000, translate('settings:duration.twoMinutes')],
    [240000, translate('settings:duration.fourMinutes')],
    [480000, translate('settings:duration.eightMinutes')],
    [900000, translate('settings:duration.fifteenMinutes')],
  ]
}

function getMemoryOptions(): [string, string][] {
  return [
    ['250m', '250 MB'],
    ['500m', translate('settings:official.recommendedMemory')],
    ['512m', '512 MB'],
    ['1g', '1 GB'],
    ['2g', '2 GB'],
    ['4g', '4 GB'],
    ['8g', '8 GB'],
  ]
}

function getBasicOptions(): [string, string, string, boolean][] {
  return [
    [
      'enabled',
      translate('settings:official.autoAfterToken'),
      translate('settings:enable'),
      true,
    ],
    [
      'sync_telemetry',
      translate('settings:official.syncTelemetry'),
      translate('settings:official.syncTelemetryHelp'),
      false,
    ],
  ]
}

function getAdvancedOptions(): [string, string, string][] {
  return [
    [
      'wipe',
      translate('settings:official.wipe'),
      translate('settings:official.wipeHelp'),
    ],
    [
      'apply_seed',
      translate('settings:official.applySeed'),
      translate('settings:official.applySeedHelp'),
    ],
    [
      'reconcile_fingerprint',
      translate('settings:official.fingerprint'),
      translate('settings:official.fingerprintHelp'),
    ],
  ]
}

function SwitchRow({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string
  label: string
  hint: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className='flex items-center justify-between gap-3 py-1.5'>
      <div className='min-w-0'>
        <Label htmlFor={id} className='text-sm font-normal'>
          {label}
        </Label>
        <p className='text-xs text-muted-foreground'>{hint}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  )
}

export function OfficialCcSettingsPane({
  config,
  onChange,
}: {
  config: OfficialCcConfig
  onChange: (next: OfficialCcConfig) => void
}) {
  const { t } = useTranslation('settings')

  const set = (patch: OfficialCcConfig) => onChange({ ...config, ...patch })
  const timeout = Number(config.timeout_ms ?? 240000)
  const memory = String(config.memory ?? '500m')
  const timeouts = getTimeouts().some(([v]) => v === timeout)
    ? getTimeouts()
    : [
        ...getTimeouts(),
        [
          timeout,
          t('duration.seconds', { value1: Math.round(timeout / 1000) }),
        ] as [number, string],
      ]

  return (
    <Card>
      <CardHeader className='pb-2'>
        <CardTitle className='text-sm'>{t('official.title')}</CardTitle>
      </CardHeader>
      <CardContent className='space-y-3'>
        <p className='text-xs text-muted-foreground'>
          {t('official.description')}
        </p>

        <div className='divide-y'>
          {getBasicOptions().map(([key, label, hint, defaultOn]) => (
            <SwitchRow
              key={key}
              id={`occ-${key}`}
              label={label}
              hint={hint}
              checked={defaultOn ? config[key] !== false : config[key] === true}
              onChange={(v) => set({ [key]: v })}
            />
          ))}
          <SwitchRow
            id='occ-resident'
            label={t('official.resident')}
            hint={t('official.residentHelp')}
            checked={config.resident === true}
            onChange={(v) => set({ resident: v })}
          />
        </div>

        <Collapsible>
          <CollapsibleTrigger className='text-sm text-muted-foreground hover:text-foreground'>
            {t('advanced')}
          </CollapsibleTrigger>
          <CollapsibleContent className='space-y-3 pt-3'>
            <div className='divide-y'>
              {getAdvancedOptions().map(([key, label, hint]) => (
                <SwitchRow
                  key={key}
                  id={`occ-${key}`}
                  label={label}
                  hint={hint}
                  checked={config[key] !== false}
                  onChange={(v) => set({ [key]: v })}
                />
              ))}
            </div>

            <div className='space-y-1.5'>
              <Label htmlFor='occ-hello'>{t('official.helloPrompt')}</Label>
              <Input
                id='occ-hello'
                maxLength={200}
                value={String(config.hello_prompt ?? 'hello')}
                onChange={(e) => set({ hello_prompt: e.target.value })}
              />
            </div>

            <div className='grid gap-3 sm:grid-cols-2'>
              <div className='space-y-1.5'>
                <Label htmlFor='occ-timeout'>{t('official.timeout')}</Label>
                <Select
                  value={String(timeout)}
                  onValueChange={(v) => set({ timeout_ms: Number(v) })}
                >
                  <SelectTrigger id='occ-timeout'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {timeouts.map(([v, l]) => (
                      <SelectItem key={v} value={String(v)}>
                        {l}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className='space-y-1.5'>
                <Label htmlFor='occ-memory'>{t('official.memory')}</Label>
                <Select
                  value={memory}
                  onValueChange={(v) => set({ memory: v })}
                >
                  <SelectTrigger id='occ-memory'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {getMemoryOptions().map(([v, l]) => (
                      <SelectItem key={v} value={v}>
                        {l}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <p className='text-xs text-muted-foreground'>
              {t('official.runtimeHelp')}
            </p>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  )
}
