import { useMutation, useQuery } from '@tanstack/react-query'
import { t as translate } from '@/i18n'
import type {
  NotifyConfig,
  NotifyEvents,
  NotifyTelegramConfig,
  NotifyWecomConfig,
} from '@/types/panel-routing'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { fmtExpiresAt } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { SettingRow } from '@/components/setting-row'
import { StatusMark } from '@/components/status-mark'
import { notifyQueryOptions } from '@/features/settings/queries'

const DEFAULT_EVENTS: NotifyEvents = {
  pool_empty: true,
  pool_low: true,
  pool_recovered: true,
  digest: true,
  revoked: true,
  invalid: true,
  account_down: false,
  account_up: false,
}

function getEventFields(): {
  key: keyof NotifyEvents
  label: string
  desc: string
}[] {
  return [
    {
      key: 'pool_empty',
      label: translate('settings:notify.poolEmpty'),
      desc: translate('settings:notify.poolEmptyHelp'),
    },
    {
      key: 'pool_low',
      label: translate('settings:notify.poolLow'),
      desc: translate('settings:notify.poolLowHelp'),
    },
    {
      key: 'pool_recovered',
      label: translate('settings:notify.poolRecovered'),
      desc: translate('settings:notify.poolRecoveredHelp'),
    },
    {
      key: 'digest',
      label: translate('settings:notify.periodic'),
      desc: translate('settings:notify.periodicHelp'),
    },
    {
      key: 'revoked',
      label: translate('settings:notify.revoked'),
      desc: translate('settings:notify.revokedHelp'),
    },
    {
      key: 'invalid',
      label: translate('settings:notify.invalid'),
      desc: translate('settings:notify.invalidHelp'),
    },
    {
      key: 'account_down',
      label: translate('settings:notify.offline'),
      desc: translate('settings:notify.offlineHelp'),
    },
    {
      key: 'account_up',
      label: translate('settings:notify.online'),
      desc: translate('settings:notify.onlineHelp'),
    },
  ]
}

function notifyConfig(value: NotifyConfig | undefined): NotifyConfig {
  return {
    enabled: false,
    interval_sec: 60,
    cooldown_sec: 300,
    digest_sec: 21600,
    min_available: 1,
    run_on_start: true,
    console_url: '',
    ...value,
    events: { ...DEFAULT_EVENTS, ...(value?.events || {}) },
    telegram: {
      enabled: false,
      bot_token: '',
      chat_id: '',
      ...(value?.telegram || {}),
    },
    wecom: {
      enabled: false,
      webhook: '',
      mention_all: false,
      ...(value?.wecom || {}),
    },
  }
}

function NumberField({
  ariaLabel,
  value,
  min,
  max,
  onChange,
}: {
  ariaLabel: string
  value: number
  min: number
  max: number
  onChange: (value: number) => void
}) {
  return (
    <Input
      className='w-28 tabular-nums'
      type='number'
      aria-label={ariaLabel}
      min={min}
      max={max}
      value={value}
      onChange={(event) => onChange(Number(event.target.value) || min)}
    />
  )
}

export function NotifyPane({
  value,
  onChange,
}: {
  value: NotifyConfig | undefined
  onChange: (next: NotifyConfig) => void
}) {
  const { t } = useTranslation('settings')

  const config = notifyConfig(value)
  const telegram = config.telegram
  const wecom = config.wecom
  const status = useQuery(notifyQueryOptions())

  const testTelegram = useMutation({
    mutationFn: () => {
      if (!telegram.bot_token.trim() && !telegram.bot_token_set) {
        throw new Error(t('notify.tokenRequired'))
      }
      if (!telegram.chat_id.trim()) throw new Error(t('notify.chatRequired'))
      return api('/api/panel/notify/test', {
        method: 'POST',
        body: JSON.stringify({
          channel: 'telegram',
          telegram: { ...telegram, enabled: true },
        }),
      })
    },
    onSuccess: async () => {
      toast.success(t('notify.telegramSent'))
      await status.refetch()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const testWecom = useMutation({
    mutationFn: () => {
      if (!wecom.webhook.trim() && !wecom.webhook_set) {
        throw new Error(t('notify.webhookRequired'))
      }
      return api('/api/panel/notify/test', {
        method: 'POST',
        body: JSON.stringify({
          channel: 'wecom',
          wecom: { ...wecom, enabled: true },
        }),
      })
    },
    onSuccess: async () => {
      toast.success(t('notify.wecomSent'))
      await status.refetch()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const patch = (next: Partial<NotifyConfig>) =>
    onChange({ ...config, ...next })
  const patchTelegram = (next: Partial<NotifyTelegramConfig>) =>
    patch({ telegram: { ...telegram, ...next } })
  const patchWecom = (next: Partial<NotifyWecomConfig>) =>
    patch({ wecom: { ...wecom, ...next } })
  const patchEvent = (key: keyof NotifyEvents, enabled: boolean) =>
    patch({ events: { ...config.events, [key]: enabled } })

  return (
    <>
      <Card>
        <CardHeader className='flex flex-row items-center justify-between gap-3'>
          <CardTitle>{t('notify.status')}</CardTitle>
          <Button
            variant='outline'
            size='sm'
            loading={status.isFetching}
            onClick={() => status.refetch()}
          >
            {t('notify.refreshStatus')}
          </Button>
        </CardHeader>
        <CardContent className='space-y-3'>
          <div className='flex flex-wrap items-center gap-x-6 gap-y-2 text-sm'>
            <StatusMark
              tone={
                status.data?.channels?.telegram
                  ? {
                      key: 'telegram-ready',
                      cls: 'ok',
                      text: t('notify.telegramReady'),
                    }
                  : {
                      key: 'telegram-missing',
                      cls: 'none',
                      text: t('notify.telegramNotReady'),
                    }
              }
              variant='pill'
            />
            <StatusMark
              tone={
                status.data?.channels?.wecom
                  ? {
                      key: 'wecom-ready',
                      cls: 'ok',
                      text: t('notify.wecomReady'),
                    }
                  : {
                      key: 'wecom-missing',
                      cls: 'none',
                      text: t('notify.wecomNotReady'),
                    }
              }
              variant='pill'
            />
            <span className='text-muted-foreground'>
              {t('notify.lastCheck', {
                value1: fmtExpiresAt(status.data?.last_run_at),
              })}
            </span>
          </div>
          {status.error ? (
            <p role='alert' className='text-sm text-destructive'>
              {t('notify.statusFailed', {
                value1: (status.error as Error).message,
              })}
            </p>
          ) : null}
          {status.data?.last_error ? (
            <p role='alert' className='text-sm text-destructive'>
              {t('notify.lastError', { value1: status.data.last_error })}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('notify.policy')}</CardTitle>
        </CardHeader>
        <CardContent className='divide-y'>
          <SettingRow label={t('notify.enable')} desc={t('notify.enableHelp')}>
            <Switch
              checked={config.enabled}
              aria-label={t('notify.enable')}
              onCheckedChange={(enabled) => patch({ enabled })}
            />
          </SettingRow>
          <SettingRow
            label={t('notify.checkOnStart')}
            desc={t('notify.checkOnStartHelp')}
          >
            <Switch
              checked={config.run_on_start}
              aria-label={t('notify.checkOnStart')}
              onCheckedChange={(run_on_start) => patch({ run_on_start })}
            />
          </SettingRow>
          <SettingRow
            label={t('notify.checkInterval')}
            desc={t('notify.minimumCheck')}
          >
            <NumberField
              ariaLabel={t('notify.checkIntervalSeconds')}
              value={config.interval_sec}
              min={15}
              max={86400}
              onChange={(interval_sec) => patch({ interval_sec })}
            />
          </SettingRow>
          <SettingRow
            label={t('notify.cooldown')}
            desc={t('notify.cooldownHelp')}
          >
            <NumberField
              ariaLabel={t('notify.cooldownSeconds')}
              value={config.cooldown_sec}
              min={30}
              max={86400}
              onChange={(cooldown_sec) => patch({ cooldown_sec })}
            />
          </SettingRow>
          <SettingRow
            label={t('notify.reportInterval')}
            desc={t('notify.minimumReport')}
          >
            <NumberField
              ariaLabel={t('notify.reportIntervalSeconds')}
              value={config.digest_sec}
              min={300}
              max={86400}
              onChange={(digest_sec) => patch({ digest_sec })}
            />
          </SettingRow>
          <SettingRow
            label={t('notify.minimumAvailable')}
            desc={t('notify.minimumAvailableHelp')}
          >
            <NumberField
              ariaLabel={t('notify.minimumAvailable')}
              value={config.min_available}
              min={1}
              max={1000}
              onChange={(min_available) => patch({ min_available })}
            />
          </SettingRow>
          <SettingRow
            label={t('notify.consoleUrl')}
            desc={t('notify.consoleUrlHelp')}
          >
            <Input
              aria-label={t('notify.consoleUrl')}
              className='w-full min-w-56 sm:w-80'
              maxLength={200}
              placeholder={location.origin}
              value={config.console_url}
              onChange={(event) => patch({ console_url: event.target.value })}
            />
          </SettingRow>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('notify.events')}</CardTitle>
        </CardHeader>
        <CardContent className='divide-y'>
          {getEventFields().map((field) => (
            <SettingRow key={field.key} label={field.label} desc={field.desc}>
              <Switch
                checked={config.events[field.key]}
                aria-label={field.label}
                onCheckedChange={(enabled) => patchEvent(field.key, enabled)}
              />
            </SettingRow>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className='flex flex-row items-center justify-between gap-3'>
          <CardTitle>{t('notify.telegramBot')}</CardTitle>
          <Button
            variant='outline'
            size='sm'
            loading={testTelegram.isPending}
            onClick={() => testTelegram.mutate()}
          >
            {t('notify.sendTest')}
          </Button>
        </CardHeader>
        <CardContent className='divide-y'>
          <SettingRow
            label={t('notify.enableTelegram')}
            desc={t('notify.channelHelp')}
          >
            <Switch
              checked={telegram.enabled}
              aria-label={t('notify.enableTelegram')}
              onCheckedChange={(enabled) => patchTelegram({ enabled })}
            />
          </SettingRow>
          <SettingRow
            label={t('notify.botToken')}
            desc={
              telegram.bot_token_set
                ? t('notify.savedToken')
                : t('notify.tokenHelp')
            }
          >
            <Input
              aria-label={t('notify.botToken')}
              className='w-full min-w-56 sm:w-80'
              type='password'
              autoComplete='new-password'
              maxLength={500}
              placeholder={
                telegram.bot_token_set ? t('savedBlankKeeps') : '123456:AA…'
              }
              value={telegram.bot_token}
              onChange={(event) =>
                patchTelegram({ bot_token: event.target.value })
              }
            />
          </SettingRow>
          <SettingRow label={t('notify.chatId')} desc={t('notify.chatHelp')}>
            <Input
              aria-label={t('notify.chatId')}
              className='w-full min-w-56 sm:w-80'
              maxLength={80}
              placeholder='-100…'
              value={telegram.chat_id}
              onChange={(event) =>
                patchTelegram({ chat_id: event.target.value })
              }
            />
          </SettingRow>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className='flex flex-row items-center justify-between gap-3'>
          <CardTitle>{t('notify.wecomBot')}</CardTitle>
          <Button
            variant='outline'
            size='sm'
            loading={testWecom.isPending}
            onClick={() => testWecom.mutate()}
          >
            {t('notify.sendTest')}
          </Button>
        </CardHeader>
        <CardContent className='divide-y'>
          <SettingRow
            label={t('notify.enableWecom')}
            desc={t('notify.channelHelp')}
          >
            <Switch
              checked={wecom.enabled}
              aria-label={t('notify.enableWecom')}
              onCheckedChange={(enabled) => patchWecom({ enabled })}
            />
          </SettingRow>
          <SettingRow
            label='Webhook'
            desc={
              wecom.webhook_set
                ? t('notify.savedWebhook')
                : t('notify.webhookHelp')
            }
          >
            <Input
              aria-label={t('notify.wecomWebhook')}
              className='w-full min-w-56 sm:w-80'
              type='password'
              autoComplete='new-password'
              maxLength={500}
              placeholder={
                wecom.webhook_set
                  ? t('savedBlankKeeps')
                  : 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…'
              }
              value={wecom.webhook}
              onChange={(event) => patchWecom({ webhook: event.target.value })}
            />
          </SettingRow>
          <SettingRow
            label={t('notify.mentionAll')}
            desc={t('notify.mentionAllHelp')}
          >
            <Switch
              checked={wecom.mention_all}
              aria-label={t('notify.wecomMentionAll')}
              onCheckedChange={(mention_all) => patchWecom({ mention_all })}
            />
          </SettingRow>
        </CardContent>
      </Card>
    </>
  )
}
