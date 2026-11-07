import { useQuery } from '@tanstack/react-query'
import { t as tr } from '@/i18n'
import type { PersonaPreset } from '@/types/panel-routing'
import { Compass } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { personaPresetLabel } from '@/lib/persona-template'
import { Badge } from '@/components/ui/badge'
import { outboundProfileQueryOptions } from './queries'
import { PaneSection } from './scheduler-controls'

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className='grid gap-1 py-2 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-3'>
      <dt className='text-xs text-muted-foreground'>{label}</dt>
      <dd className='font-mono text-xs break-all'>{value}</dd>
    </div>
  )
}

/** 只读：已保存的全局提示词档实际发出的版本与请求头。槽位覆盖见槽位详情。 */
export function OutboundReference() {
  const { t } = useTranslation('settings')
  const query = useQuery(outboundProfileQueryOptions())
  const profile = query.data?.profile

  return (
    <PaneSection
      icon={Compass}
      title={t('outboundReferenceTitle')}
      desc={t('outboundReferenceDescription')}
      aside={profile ? <Badge>{profile.cli_version}</Badge> : null}
    >
      {query.isError ? (
        <p role='alert' className='text-sm text-destructive'>
          {t('outboundReferenceError', { error: query.error.message })}
        </p>
      ) : !profile ? (
        <p className='text-sm text-muted-foreground'>
          {t('outboundReferenceLoading')}
        </p>
      ) : (
        <dl className='divide-y'>
          <Row
            label={t('outboundReferencePreset')}
            value={`${personaPresetLabel(profile.preset as PersonaPreset)} (${profile.preset})`}
          />
          <Row
            label={t('outboundReferenceUserAgent')}
            value={profile.user_agent}
          />
          <Row
            label={tr('settings:sync14008EntrypointField')}
            value={profile.cc_entrypoint}
          />
          <Row
            label={t('outboundReferenceBilling')}
            value={`cc_version=${profile.cli_version}.<fingerprint>; cc_entrypoint=${profile.cc_entrypoint}`}
          />
          <Row
            label={t('outboundReferenceBeta', {
              model: profile.beta_sample_model,
            })}
            value={profile.anthropic_beta}
          />
        </dl>
      )}
    </PaneSection>
  )
}
