import { Ban, ShieldCheck, TextQuote } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { SettingRow } from '@/components/setting-row'
import { PaneSection } from './scheduler-controls'

type Block = Record<string, unknown>
type Rule = { kind?: string; prefix?: string; regex?: string }

const KINDS = [
  {
    id: 'ssn',
    label: 'redaction.kind.ssn',
    desc: 'redaction.kind.ssnHelp',
    on: true,
  },
  {
    id: 'passport',
    label: 'redaction.kind.passport',
    desc: 'redaction.kind.passportHelp',
    on: true,
  },
  {
    id: 'iban',
    label: 'redaction.kind.iban',
    desc: 'redaction.kind.ibanHelp',
    on: true,
  },
  {
    id: 'birthday',
    label: 'redaction.kind.birthday',
    desc: 'redaction.kind.birthdayHelp',
    on: true,
  },
  {
    id: 'mac',
    label: 'redaction.kind.mac',
    desc: 'redaction.kind.macHelp',
    on: true,
  },
  {
    id: 'serial',
    label: 'redaction.kind.serial',
    desc: 'redaction.kind.serialHelp',
    on: true,
  },
  {
    id: 'home',
    label: 'redaction.kind.home',
    desc: 'redaction.kind.homeHelp',
    on: false,
  },
  {
    id: 'userhost',
    label: 'redaction.kind.userhost',
    desc: 'redaction.kind.userhostHelp',
    on: false,
  },
  {
    id: 'ip',
    label: 'redaction.kind.ip',
    desc: 'redaction.kind.ipHelp',
    on: false,
  },
  {
    id: 'bucket',
    label: 'redaction.kind.bucket',
    desc: 'redaction.kind.bucketHelp',
    on: false,
  },
] as const

export function RedactionPane({
  redaction,
  runtime,
  onChange,
}: {
  redaction: Block
  runtime: Block
  onChange: (next: Block) => void
}) {
  const { t } = useTranslation('settings')
  const enabled = redaction.enabled === true
  const personal = redaction.personal !== false
  const kinds =
    redaction.kinds &&
    typeof redaction.kinds === 'object' &&
    !Array.isArray(redaction.kinds)
      ? (redaction.kinds as Record<string, boolean>)
      : {}
  const rules = Array.isArray(redaction.rules)
    ? (redaction.rules as Rule[])
    : []
  const status = runtime.error
    ? t('redaction.statusBlocked')
    : runtime.enabled && runtime.ready
      ? t('redaction.statusProtecting')
      : enabled
        ? t('redaction.statusSaved')
        : t('redaction.statusOff')

  function patch(next: Block) {
    onChange({ ...redaction, ...next })
  }

  function setRule(index: number, next: Rule) {
    patch({ rules: rules.map((rule, at) => (at === index ? next : rule)) })
  }

  return (
    <div className='space-y-4'>
      <PaneSection
        icon={ShieldCheck}
        title={t('redaction.title')}
        desc={t('redaction.desc')}
        aside={
          <Badge
            variant={runtime.ready && runtime.enabled ? 'default' : 'secondary'}
          >
            {status}
          </Badge>
        }
      >
        <div className='divide-y'>
          <SettingRow
            label={t('redaction.enable')}
            desc={t('redaction.enableHelp')}
          >
            <Switch
              checked={enabled}
              onCheckedChange={(on) => patch({ enabled: on })}
              aria-label={t('redaction.enableAria')}
            />
          </SettingRow>
          <SettingRow
            label={t('redaction.secrets')}
            desc={t('redaction.secretsHelp')}
          >
            <Switch
              checked={redaction.secrets !== false}
              onCheckedChange={(on) => patch({ secrets: on })}
              aria-label={t('redaction.secretsAria')}
            />
          </SettingRow>
          <SettingRow
            label={t('redaction.personal')}
            desc={t('redaction.personalHelp')}
          >
            <Switch
              checked={personal}
              onCheckedChange={(on) => patch({ personal: on })}
              aria-label={t('redaction.personalAria')}
            />
          </SettingRow>
        </div>
      </PaneSection>

      <PaneSection
        icon={ShieldCheck}
        title={t('redaction.kindsTitle')}
        desc={t('redaction.kindsDesc')}
      >
        <div className='divide-y'>
          {KINDS.map((kind) => (
            <SettingRow key={kind.id} label={t(kind.label)} desc={t(kind.desc)}>
              <Switch
                checked={kinds[kind.id] ?? kind.on}
                disabled={!personal}
                onCheckedChange={(on) =>
                  patch({ kinds: { ...kinds, [kind.id]: on } })
                }
                aria-label={t(kind.label)}
              />
            </SettingRow>
          ))}
        </div>
      </PaneSection>

      <PaneSection
        icon={TextQuote}
        title={t('redaction.customTitle')}
        desc={t('redaction.customDesc')}
      >
        <div className='space-y-4'>
          <SettingRow
            label={t('redaction.ignoreCase')}
            desc={t('redaction.ignoreCaseHelp')}
          >
            <Switch
              checked={redaction.wordsAnyCase === true}
              onCheckedChange={(on) => patch({ wordsAnyCase: on })}
              aria-label={t('redaction.ignoreCaseAria')}
            />
          </SettingRow>
          <label className='block space-y-1.5'>
            <span className='text-sm font-medium'>{t('redaction.words')}</span>
            <textarea
              aria-label={t('redaction.wordsAria')}
              rows={4}
              value={
                Array.isArray(redaction.words)
                  ? redaction.words.map((item) => String(item)).join('\n')
                  : ''
              }
              onChange={(event) =>
                patch({ words: event.target.value.split('\n') })
              }
              className='w-full rounded-md border bg-transparent p-2 font-mono text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
            />
          </label>
          <div className='space-y-2'>
            <div className='flex items-center justify-between gap-3'>
              <span className='text-sm font-medium'>
                {t('redaction.rules')}
              </span>
              <Button
                type='button'
                size='sm'
                variant='outline'
                disabled={rules.length >= 32}
                onClick={() =>
                  patch({
                    rules: [...rules, { kind: '', prefix: '', regex: '' }],
                  })
                }
              >
                {t('redaction.addRule')}
              </Button>
            </div>
            {rules.length === 0 ? (
              <p className='text-xs leading-5 text-muted-foreground'>
                {t('redaction.noRules')}
              </p>
            ) : (
              <ul className='space-y-2'>
                {rules.map((rule, index) => {
                  const mode = rule.regex ? 'regex' : 'prefix'
                  return (
                    <li
                      key={index}
                      className='grid gap-2 rounded-md border p-2 sm:grid-cols-[8rem_6rem_1fr_auto]'
                    >
                      <input
                        aria-label={t('redaction.ruleName', {
                          index: index + 1,
                        })}
                        value={rule.kind || ''}
                        onChange={(event) =>
                          setRule(index, { ...rule, kind: event.target.value })
                        }
                        placeholder={t('redaction.namePlaceholder')}
                        className='rounded-md border bg-transparent px-2 py-1.5 font-mono text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
                      />
                      <select
                        aria-label={t('redaction.ruleType', {
                          index: index + 1,
                        })}
                        value={mode}
                        onChange={(event) =>
                          setRule(
                            index,
                            event.target.value === 'regex'
                              ? {
                                  kind: rule.kind,
                                  prefix: '',
                                  regex: rule.prefix || rule.regex || '',
                                }
                              : {
                                  kind: rule.kind,
                                  prefix: rule.regex || rule.prefix || '',
                                  regex: '',
                                }
                          )
                        }
                        className='rounded-md border bg-transparent px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
                      >
                        <option value='prefix'>{t('redaction.prefix')}</option>
                        <option value='regex'>{t('redaction.regex')}</option>
                      </select>
                      <input
                        aria-label={t('redaction.ruleContent', {
                          index: index + 1,
                        })}
                        value={
                          mode === 'regex'
                            ? rule.regex || ''
                            : rule.prefix || ''
                        }
                        onChange={(event) =>
                          setRule(
                            index,
                            mode === 'regex'
                              ? {
                                  kind: rule.kind,
                                  prefix: '',
                                  regex: event.target.value,
                                }
                              : {
                                  kind: rule.kind,
                                  prefix: event.target.value,
                                  regex: '',
                                }
                          )
                        }
                        placeholder={
                          mode === 'regex'
                            ? t('redaction.regexPlaceholder')
                            : t('redaction.prefixPlaceholder')
                        }
                        className='rounded-md border bg-transparent px-2 py-1.5 font-mono text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
                      />
                      <Button
                        type='button'
                        size='sm'
                        variant='ghost'
                        onClick={() =>
                          patch({
                            rules: rules.filter((_, at) => at !== index),
                          })
                        }
                      >
                        {t('redaction.delete')}
                      </Button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>
      </PaneSection>

      <PaneSection
        icon={Ban}
        title={t('redaction.allowTitle')}
        desc={t('redaction.allowDesc')}
      >
        <textarea
          aria-label={t('redaction.allowAria')}
          rows={4}
          value={
            Array.isArray(redaction.allow)
              ? redaction.allow.map((item) => String(item)).join('\n')
              : ''
          }
          onChange={(event) => patch({ allow: event.target.value.split('\n') })}
          className='w-full rounded-md border bg-transparent p-2 font-mono text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
        />
      </PaneSection>

      <PaneSection
        icon={Ban}
        title={t('redaction.notDoneTitle')}
        desc={t('redaction.notDoneDesc')}
      >
        <ul className='space-y-1 text-sm leading-6 text-muted-foreground'>
          <li>{t('redaction.notDone1')}</li>
          <li>{t('redaction.notDone2')}</li>
          <li>{t('redaction.notDone3')}</li>
        </ul>
      </PaneSection>
    </div>
  )
}
