import type { ClientProfileSelection } from '@/types/panel-keys'
import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cleanProfile } from './codex-profile'

const SELECT = 'h-9 w-full rounded border bg-background px-2 text-sm'

export function ClientProfileEditor({
  value,
  onChange,
  disabled,
  idPrefix,
}: {
  value: ClientProfileSelection
  onChange: (next: ClientProfileSelection) => void
  disabled?: boolean
  idPrefix: string
}) {
  const { t } = useTranslation('settings')
  const custom = value.mode === 'custom'
  const set = (patch: Partial<ClientProfileSelection>) =>
    onChange(cleanProfile({ ...value, ...patch }))
  return (
    <div className='space-y-3'>
      <div className='grid gap-3 sm:grid-cols-3'>
        <Label className='flex flex-col items-start gap-2'>
          {t('codexProfile.mode')}
          <select
            className={SELECT}
            disabled={disabled}
            value={custom ? 'custom' : value.client || 'desktop'}
            onChange={(event) =>
              event.target.value === 'custom'
                ? onChange({ mode: 'custom', userAgent: '' })
                : set({
                    mode: undefined,
                    client: event.target.value as 'desktop' | 'cli',
                  })
            }
          >
            <option value='desktop'>{t('codexProfile.clientDesktop')}</option>
            <option value='cli'>{t('codexProfile.clientCli')}</option>
            <option value='custom'>{t('codexProfile.clientCustom')}</option>
          </select>
        </Label>
        {!custom ? (
          <>
            <Label className='flex flex-col items-start gap-2'>
              {t('codexProfile.platform')}
              <select
                className={SELECT}
                disabled={disabled}
                value={value.platform || 'macos'}
                onChange={(event) =>
                  set({
                    platform: event.target
                      .value as ClientProfileSelection['platform'],
                  })
                }
              >
                <option value='macos'>macOS</option>
                <option value='windows'>
                  {
                    /* i18n-exempt "Windows" -- Operating system product name, identical in every locale. */ 'Windows'
                  }
                </option>
                <option value='linux'>
                  {
                    /* i18n-exempt "Linux" -- Operating system product name, identical in every locale. */ 'Linux'
                  }
                </option>
              </select>
            </Label>
            <Label className='flex flex-col items-start gap-2'>
              {t('codexProfile.version')}
              <select
                className={SELECT}
                disabled={disabled}
                value={value.versionMode || 'latest'}
                onChange={(event) =>
                  set({
                    versionMode: event.target.value as 'latest' | 'fixed',
                  })
                }
              >
                <option value='latest'>
                  {t('codexProfile.versionLatest')}
                </option>
                <option value='fixed'>{t('codexProfile.versionFixed')}</option>
              </select>
            </Label>
          </>
        ) : null}
      </div>
      {custom ? (
        <div className='grid gap-3 sm:grid-cols-3'>
          <Label
            htmlFor={`${idPrefix}-ua`}
            className='flex flex-col items-start gap-2 sm:col-span-3'
          >
            {
              /* i18n-exempt "User-Agent" -- HTTP header name shown verbatim. */ 'User-Agent'
            }
            <Input
              id={`${idPrefix}-ua`}
              disabled={disabled}
              value={value.userAgent || ''}
              placeholder={
                /* i18n-exempt "codex_cli_rs/0.155.0 (Mac OS 15.7.1; arm64) iTerm.app" -- Example official Codex User-Agent wire value. */ 'codex_cli_rs/0.155.0 (Mac OS 15.7.1; arm64) iTerm.app'
              }
              onChange={(event) => set({ userAgent: event.target.value })}
            />
          </Label>
          <Label className='flex flex-col items-start gap-2'>
            {
              /* i18n-exempt "originator" -- Codex originator header name shown verbatim. */ 'originator'
            }
            <Input
              disabled={disabled}
              value={value.originator || ''}
              placeholder={t('codexProfile.optional')}
              onChange={(event) => set({ originator: event.target.value })}
            />
          </Label>
          <Label className='flex flex-col items-start gap-2'>
            {t('codexProfile.coreVersion')}
            <Input
              disabled={disabled}
              value={value.codexVersion || ''}
              placeholder={t('codexProfile.optional')}
              onChange={(event) => set({ codexVersion: event.target.value })}
            />
          </Label>
          <p className='text-xs text-muted-foreground sm:col-span-3'>
            {t('codexProfile.customHelp')}
          </p>
        </div>
      ) : (
        <div className='grid gap-3 sm:grid-cols-3'>
          {value.client === 'cli' ? (
            <Label className='flex flex-col items-start gap-2'>
              {t('codexProfile.cliEntry')}
              <select
                className={SELECT}
                disabled={disabled}
                value={value.cliEntry || ''}
                onChange={(event) =>
                  set({
                    cliEntry: event.target
                      .value as ClientProfileSelection['cliEntry'],
                  })
                }
              >
                <option value=''>
                  {
                    /* i18n-exempt "codex_cli_rs" -- Official Codex originator wire value. */ 'codex_cli_rs'
                  }
                </option>
                <option value='tui'>
                  {
                    /* i18n-exempt "codex-tui" -- Official Codex originator wire value. */ 'codex-tui'
                  }
                </option>
                <option value='exec'>
                  {
                    /* i18n-exempt "codex_exec" -- Official Codex originator wire value. */ 'codex_exec'
                  }
                </option>
              </select>
            </Label>
          ) : null}
          {(value.versionMode || 'latest') === 'latest' ? (
            <Label className='flex flex-col items-start gap-2'>
              {t('codexProfile.versionLag')}
              <Input
                type='number'
                min={0}
                max={10}
                disabled={disabled}
                value={value.versionLag || 0}
                onChange={(event) =>
                  set({
                    versionLag: Math.max(
                      0,
                      Math.min(10, Number(event.target.value) || 0)
                    ),
                  })
                }
              />
            </Label>
          ) : (
            <>
              <Label className='flex flex-col items-start gap-2'>
                {t('codexProfile.coreVersion')}
                <Input
                  disabled={disabled}
                  value={value.codexVersion || ''}
                  placeholder='0.155.0'
                  onChange={(event) =>
                    set({ codexVersion: event.target.value })
                  }
                />
              </Label>
              {value.client === 'desktop' ? (
                <>
                  <Label className='flex flex-col items-start gap-2'>
                    {t('codexProfile.desktopVersion')}
                    <Input
                      disabled={disabled}
                      value={value.desktopVersion || ''}
                      placeholder='26.901.51231'
                      onChange={(event) =>
                        set({ desktopVersion: event.target.value })
                      }
                    />
                  </Label>
                  <Label className='flex flex-col items-start gap-2'>
                    {t('codexProfile.desktopBuild')}
                    <Input
                      disabled={disabled}
                      value={value.desktopBuild || ''}
                      placeholder='8109'
                      onChange={(event) =>
                        set({ desktopBuild: event.target.value })
                      }
                    />
                  </Label>
                </>
              ) : null}
            </>
          )}
        </div>
      )}
    </div>
  )
}
