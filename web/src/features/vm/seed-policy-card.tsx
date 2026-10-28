import { useEffect, useState } from 'react'
import type { VmKernelSnapshot, VmSeedSettings } from '@/types/panel-vm'
import { useTranslation, Trans } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
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
import { Textarea } from '@/components/ui/textarea'
import { ConfirmDialog } from '@/components/confirm-dialog'
import {
  REJECT_FLAGS,
  SEED_LOCALE_OPTIONS,
  SEED_TIMEZONE_OPTIONS,
  claudeSettingKeys,
  partitionSeedEnvKeys,
  seedDraftOf,
  seedSaveBody,
  settingsRows,
  sameDraft,
  telemetryLive,
  type SeedDraft,
  type SeedSlotContext,
} from '@/features/vm/seed-settings'
import { telemetryEnabled } from '@/features/vm/telemetry-policy'

type ObservedTelemetry = NonNullable<VmKernelSnapshot['telemetry']>

function Lamp({ tone }: { tone: 'on' | 'off' | 'unknown' }) {
  useTranslation('vm')

  return (
    <span
      aria-hidden
      className={cn(
        'relative inline-flex size-2.5 shrink-0 rounded-full',
        tone === 'on' && 'bg-primary',
        tone === 'off' && 'bg-[var(--status-warn)]',
        tone === 'unknown' && 'bg-muted-foreground/50'
      )}
    >
      {tone !== 'unknown' ? (
        <span
          className={cn(
            'absolute inset-0 rounded-full motion-safe:animate-ping',
            tone === 'on' ? 'bg-primary/70' : 'bg-[var(--status-warn)]/70'
          )}
        />
      ) : null}
    </span>
  )
}

function namedChoice(
  table: readonly (readonly [string, string])[],
  value: string
) {
  return (
    table.find(([key, zone]) => key === value || zone === value)?.[0] ||
    'custom'
  )
}

function ChoiceField({
  label,
  table,
  value,
  disabled,
  onChange,
}: {
  label: string
  table: readonly (readonly [string, string])[]
  value: string
  disabled: boolean
  onChange: (value: string) => void
}) {
  const { t: tVm } = useTranslation('vm')

  const selected = namedChoice(table, value)
  return (
    <Select
      value={selected}
      disabled={disabled}
      onValueChange={(key) =>
        onChange(table.find(([id]) => id === key)?.[1] || value)
      }
    >
      <SelectTrigger className='h-8 font-mono text-xs' aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {table.map(([key, zone]) => (
          <SelectItem key={key} value={key}>{`${key} · ${zone}`}</SelectItem>
        ))}
        {selected === 'custom' ? (
          <SelectItem value='custom'>
            {value || tVm('vm:seedPolicyCard.custom')}
          </SelectItem>
        ) : null}
      </SelectContent>
    </Select>
  )
}

function LocaleField(props: {
  value: string
  disabled: boolean
  onChange: (value: string) => void
}) {
  const { t: tVm } = useTranslation('vm')

  return (
    <ChoiceField
      label={tVm('vm:createVmForm.language')}
      table={SEED_LOCALE_OPTIONS}
      {...props}
    />
  )
}

function ZoneField({
  follow,
  fixed,
  proxyZone,
  disabled,
  onFollow,
  onFixed,
}: {
  follow: boolean
  fixed: string
  proxyZone: string
  disabled: boolean
  onFollow: () => void
  onFixed: (value: string) => void
}) {
  const { t: tVm } = useTranslation('vm')

  return (
    <div className='space-y-1'>
      <ChoiceField
        label={tVm('vm:physicalFeaturesCard.timezone')}
        table={SEED_TIMEZONE_OPTIONS}
        value={follow ? proxyZone : fixed}
        disabled={disabled}
        onChange={onFixed}
      />
      <Button
        type='button'
        size='sm'
        variant={follow ? 'secondary' : 'ghost'}
        className='h-7 px-2 text-xs'
        disabled={disabled || follow}
        onClick={onFollow}
      >
        {follow
          ? proxyZone
            ? tVm('vm:seedPolicyCard.followCurrentSOCKS5', {
                proxyZone: proxyZone,
              })
            : tVm('vm:seedPolicyCard.followCurrentSOCKS5TimezoneUnavailable')
          : tVm('vm:seedPolicyCard.followCurrentSOCKS5Again')}
      </Button>
      <p className='text-[11px] text-muted-foreground'>
        <Trans
          ns='vm'
          i18nKey='seedPolicyCard.writtenByTheSlotDuringSeedingNotThroughExtra'
        />
      </p>
    </div>
  )
}

function TelemetryUploadLog({ lines }: { lines: unknown }) {
  const { t: tVm } = useTranslation('vm')

  const rows = Array.isArray(lines)
    ? lines.filter(
        (line): line is string => typeof line === 'string' && line !== ''
      )
    : []
  return (
    <pre className='mt-2 max-h-72 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-[11px] leading-5 text-foreground'>
      {rows.length
        ? rows.join('\n')
        : tVm('vm:seedPolicyCard.noUploadHistoryYetItAppearsAfterTelemetryIs')}
    </pre>
  )
}

function ToggleRow({
  id,
  label,
  detail,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string
  label: string
  detail: string
  checked: boolean
  disabled: boolean
  onCheckedChange: (next: boolean) => void
}) {
  const { t: tVm } = useTranslation('vm')

  return (
    <div className='flex items-center justify-between gap-3 py-2.5'>
      <div className='min-w-0'>
        <Label htmlFor={id} className='text-sm font-medium'>
          {label}
        </Label>
        <p className='text-xs text-muted-foreground'>{detail}</p>
      </div>
      <div className='flex shrink-0 items-center gap-2'>
        <span
          className={cn(
            'shrink-0 font-mono text-[11px] tracking-wide whitespace-nowrap',
            checked ? 'text-primary' : 'text-muted-foreground'
          )}
        >
          {checked
            ? tVm('vm:seedPolicyCard.on')
            : tVm('vm:seedPolicyCard.offSwitch')}
        </span>
        <Switch
          id={id}
          checked={checked}
          disabled={disabled}
          onCheckedChange={onCheckedChange}
        />
      </div>
    </div>
  )
}

export function SeedPolicyCard({
  seed,
  slot,
  telemetry,
  onSave,
  saving,
  syncTelemetry = false,
  debug,
  onDebug,
  uploadLog,
  proxyTimezone = '',
}: {
  seed: VmSeedSettings
  slot: SeedSlotContext
  telemetry?: ObservedTelemetry | null
  onSave: (next: Record<string, unknown>) => void
  saving: boolean
  syncTelemetry?: boolean
  debug: boolean
  onDebug: (next: boolean) => void
  uploadLog?: string[] | null
  proxyTimezone?: string | null
}) {
  const { t: tVm } = useTranslation('vm')

  const [locked, setLocked] = useState(true)
  const [askUnlock, setAskUnlock] = useState(false)
  const [askSave, setAskSave] = useState(false)
  const saved = seedDraftOf(seed, slot)
  const [draft, setDraft] = useState<SeedDraft>(saved)
  useEffect(() => {
    setDraft(seedDraftOf(seed, slot))
  }, [seed, slot])

  const dirty = !sameDraft(draft, saved)
  const on = telemetryEnabled(draft)
  const live = telemetryLive(seed, telemetry)
  const fileSetting =
    typeof seed.claude_setting === 'string' ? seed.claude_setting : ''
  const rows = settingsRows(seed.settings_json, fileSetting)
  const claudeNamed = claudeSettingKeys(fileSetting)
  const fileMissing = seed.settings_json == null
  const { editable: editableEnvKeys, readonly: readonlyEnvKeys } =
    partitionSeedEnvKeys(draft.env)
  const editDisabled = locked || saving

  const patch = (next: Partial<SeedDraft>) =>
    setDraft((current) => ({ ...current, ...next }))

  return (
    <div className='grid items-start gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(18rem,0.8fr)]'>
      <section className='min-w-0 overflow-hidden rounded-xl border bg-card'>
        <header className='flex items-baseline justify-between gap-3 border-b px-4 py-3'>
          <h2 className='text-sm font-semibold'>
            <Trans ns='vm' i18nKey='seedPolicyCard.currentSlotSettingsJson' />
          </h2>
          <p className='font-mono text-[11px] text-muted-foreground'>
            {fileMissing
              ? tVm('vm:seedPolicyCard.fileNotWritten')
              : tVm('vm:seedPolicyCard.entries', {
                  length: rows.length,
                  count: rows.length,
                })}
            {locked
              ? tVm('vm:seedPolicyCard.locked')
              : tVm('vm:seedPolicyCard.unlocked')}
          </p>
        </header>
        {fileMissing ? (
          <p className='px-4 py-8 text-sm text-muted-foreground'>
            <Trans
              ns='vm'
              i18nKey='seedPolicyCard.thisSlotHasNoSettingsJsonYetSeedIt'
            />
          </p>
        ) : rows.length === 0 ? (
          <p className='px-4 py-8 text-sm text-muted-foreground'>
            <Trans
              ns='vm'
              i18nKey='seedPolicyCard.fileExistsButHasNoEnvEntries'
            />
          </p>
        ) : (
          <div className='divide-y'>
            {editableEnvKeys.map((key) => (
              <label
                key={key}
                className='grid items-center gap-2 px-4 py-2 sm:grid-cols-[minmax(0,1fr)_minmax(8rem,16rem)]'
              >
                <span className='inline-flex min-w-0 items-center gap-2 font-mono text-xs font-medium break-all'>
                  {claudeNamed.has(key) ? (
                    <span
                      className='size-1.5 shrink-0 rounded-full bg-primary'
                      title={tVm(
                        'vm:seedPolicyCard.alsoPresentInClaudeSetting'
                      )}
                    />
                  ) : (
                    <span className='size-1.5 shrink-0' />
                  )}
                  {key}
                </span>
                <Input
                  aria-label={key}
                  value={draft.env[key] ?? ''}
                  disabled={editDisabled}
                  spellCheck={false}
                  onChange={(event) =>
                    patch({ env: { ...draft.env, [key]: event.target.value } })
                  }
                  className='h-8 font-mono text-xs'
                />
              </label>
            ))}
            <label className='grid items-center gap-2 px-4 py-2 sm:grid-cols-[minmax(0,1fr)_minmax(8rem,16rem)]'>
              <span className='font-mono text-xs font-medium'>theme</span>
              <Input
                aria-label='theme'
                value={draft.theme}
                disabled={editDisabled}
                spellCheck={false}
                onChange={(event) => patch({ theme: event.target.value })}
                className='h-8 font-mono text-xs'
              />
            </label>
            {readonlyEnvKeys.map((key) => (
              <div
                key={key}
                className='grid items-center gap-2 px-4 py-2 sm:grid-cols-[minmax(0,1fr)_minmax(8rem,16rem)]'
              >
                <span className='inline-flex min-w-0 items-center gap-2 font-mono text-xs font-medium break-all'>
                  {claudeNamed.has(key) ? (
                    <span
                      className='size-1.5 shrink-0 rounded-full bg-primary'
                      title={tVm(
                        'vm:seedPolicyCard.alsoPresentInClaudeSetting'
                      )}
                    />
                  ) : (
                    <span className='size-1.5 shrink-0' />
                  )}
                  {key}
                </span>
                {key === 'TZ' ? (
                  <ZoneField
                    follow={draft.timezoneFollow}
                    fixed={draft.timezoneFixed}
                    proxyZone={proxyTimezone || ''}
                    disabled={editDisabled}
                    onFollow={() =>
                      patch({ timezoneFollow: true, timezoneFixed: '' })
                    }
                    onFixed={(value) =>
                      patch({ timezoneFollow: false, timezoneFixed: value })
                    }
                  />
                ) : key === 'LANG' ? (
                  <LocaleField
                    value={draft.locale}
                    disabled={editDisabled}
                    onChange={(value) => patch({ locale: value })}
                  />
                ) : key === 'LC_ALL' ? (
                  <span className='font-mono text-xs text-muted-foreground'>
                    <Trans
                      ns='vm'
                      i18nKey='seedPolicyCard.fixedWithLANGAtSeeding'
                      values={{ locale: draft.locale }}
                    />
                  </span>
                ) : (
                  <span className='font-mono text-xs text-muted-foreground'>
                    <Trans
                      ns='vm'
                      i18nKey='seedPolicyCard.fixedAtSeeding'
                      values={{
                        value:
                          draft.env[key] === ''
                            ? tVm('vm:seedPolicyCard.emptyValue')
                            : draft.env[key],
                      }}
                    />
                  </span>
                )}
              </div>
            ))}
            {rows
              .filter(
                (row) =>
                  row.key === 'autoUpdates' || row.key === 'grove_enabled'
              )
              .map((row) => (
                <div
                  key={row.key}
                  className='grid items-center gap-2 px-4 py-2 sm:grid-cols-[minmax(0,1fr)_minmax(8rem,16rem)]'
                >
                  <span className='font-mono text-xs font-medium'>
                    {row.key}
                  </span>
                  <span className='font-mono text-xs text-muted-foreground'>
                    <Trans
                      ns='vm'
                      i18nKey='seedPolicyCard.fixedAtSeeding'
                      values={{ value: row.value }}
                    />
                  </span>
                </div>
              ))}
          </div>
        )}
      </section>

      <aside className='min-w-0 rounded-xl border bg-card'>
        <div
          className='flex items-center gap-3 border-b px-4 py-3'
          role='status'
          aria-live='polite'
        >
          <Lamp tone={live.tone} />
          <div className='min-w-0'>
            <p className='text-sm font-semibold'>
              <Trans
                ns='vm'
                i18nKey='seedPolicyCard.telemetry'
                values={{
                  value:
                    live.on === true
                      ? tVm('vm:seedPolicyCard.on')
                      : live.on === false
                        ? tVm('vm:seedPolicyCard.offSwitch')
                        : tVm('vm:detailAccountTab.unknown'),
                }}
              />
            </p>
            <p className='text-xs text-muted-foreground'>
              {live.label}
              {live.running === true
                ? tVm('vm:seedPolicyCard.processRunning')
                : live.running === false
                  ? tVm('vm:seedPolicyCard.processStopped')
                  : tVm('vm:seedPolicyCard.processStateUnknown')}
            </p>
          </div>
        </div>

        <div className='divide-y px-4'>
          <ToggleRow
            id='seed-telemetry'
            label={tVm('vm:detailStatusBoard.telemetry')}
            detail={
              on
                ? tVm(
                    'vm:seedPolicyCard.nonessentialTraffic1DNTOffBothFollowThisSwitch'
                  )
                : tVm(
                    'vm:seedPolicyCard.nonessentialTraffic0DNTOnBothFollowThisSwitch'
                  )
            }
            checked={on}
            disabled={editDisabled}
            onCheckedChange={(value) => patch({ telemetry_disabled: !value })}
          />
          {REJECT_FLAGS.map(([key, label]) => (
            <ToggleRow
              key={key}
              id={`seed-${key}`}
              label={label}
              detail={
                key === 'reject_client_settings'
                  ? draft.reject_client_settings
                    ? tVm('vm:seedPolicyCard.incomingSettingsEnvAreDiscarded')
                    : tVm('vm:seedPolicyCard.incomingSettingsAreRetained')
                  : draft.reject_client_metadata_identity
                    ? tVm(
                        'vm:seedPolicyCard.incomingUserMachineIdentitiesAreDiscarded'
                      )
                    : tVm('vm:seedPolicyCard.incomingIdentitiesAreRetained')
              }
              checked={!!draft[key]}
              disabled={editDisabled}
              onCheckedChange={(value) => patch({ [key]: value })}
            />
          ))}
        </div>

        <div className='space-y-2 border-t px-4 py-3'>
          <Label htmlFor='seed-claude-setting' className='text-sm font-medium'>
            claude.setting
          </Label>
          <Textarea
            id='seed-claude-setting'
            value={draft.claude_setting}
            disabled={editDisabled}
            onChange={(event) => patch({ claude_setting: event.target.value })}
            className='min-h-28 font-mono text-xs'
            spellCheck={false}
            placeholder={tVm('vm:seedPolicyCard.oneKEYValuePerLine')}
          />
          <p className='text-xs text-muted-foreground'>
            {syncTelemetry
              ? tVm(
                  'vm:seedPolicyCard.theNextTokenExchangeEnablesTelemetryAgainThroughExternal'
                )
              : tVm(
                  'vm:seedPolicyCard.tokenExchangeDoesNotChangeThisTelemetrySetting'
                )}
            {dirty
              ? tVm('vm:seedPolicyCard.changesHaveNotBeenSeeded')
              : tVm('vm:seedPolicyCard.matchesTheCurrentPolicy')}
          </p>
        </div>

        <div className='flex gap-2 border-t px-4 py-3'>
          <Button
            size='sm'
            variant='outline'
            disabled={saving || !locked}
            onClick={() => setAskUnlock(true)}
          >
            <Trans ns='vm' i18nKey='seedPolicyCard.unlock' />
          </Button>
          <Button
            size='sm'
            disabled={saving || locked || !dirty}
            onClick={() => setAskSave(true)}
          >
            {saving
              ? tVm('vm:codexCredentialPanel.writing')
              : tVm('vm:officialCcCard.applySeed')}
          </Button>
          <Button
            size='sm'
            variant='ghost'
            disabled={saving || locked || !dirty}
            onClick={() => setDraft(saved)}
          >
            <Trans ns='vm' i18nKey='detailOpsTab.reset' />
          </Button>
        </div>
        <ConfirmDialog
          open={askUnlock}
          onOpenChange={setAskUnlock}
          title={tVm('vm:seedPolicyCard.unlockSeedConfiguration')}
          desc={tVm(
            'vm:seedPolicyCard.unlockToEditThisSlotSConfigurationSavingChanges'
          )}
          confirmText={tVm('vm:seedPolicyCard.unlock')}
          cancelBtnText={tVm('vm:authSchemeEditor.cancel')}
          handleConfirm={() => {
            setLocked(false)
            setAskUnlock(false)
          }}
        />
        <ConfirmDialog
          open={askSave}
          onOpenChange={setAskSave}
          title={tVm('vm:seedPolicyCard.confirmSeeding')}
          desc={tVm(
            'vm:seedPolicyCard.writesChangesToThisSlotSSettingsJsonAnd'
          )}
          confirmText={tVm('vm:seedPolicyCard.confirmWrite')}
          cancelBtnText={tVm('vm:authSchemeEditor.cancel')}
          isLoading={saving}
          handleConfirm={() => {
            onSave(seedSaveBody(draft))
            setAskSave(false)
            setLocked(true)
          }}
        />
        <div className='border-t px-4 py-3'>
          <ToggleRow
            id='seed-telemetry-debug'
            label={tVm('vm:seedPolicyCard.debugUploads')}
            detail={
              debug
                ? tVm(
                    'vm:seedPolicyCard.showTelemetryActuallyUploadedByThisSlot'
                  )
                : tVm('vm:seedPolicyCard.offByDefaultUploadHistoryIsNotFetched')
            }
            checked={debug}
            disabled={saving}
            onCheckedChange={onDebug}
          />
          {debug ? <TelemetryUploadLog lines={uploadLog} /> : null}
        </div>
      </aside>
    </div>
  )
}
