import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { t as translate } from '@/i18n'
import type { RequestLogItem } from '@/types/panel-logs'
import { Check, Copy } from 'lucide-react'
import { useTranslation, Trans } from 'react-i18next'
import { maskPresentedKey } from '@/lib/log-mute'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { requestLogQueryOptions } from '../queries'

type Section = {
  id: string
  label: string
  value: unknown
  note?: string
}

function pretty(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** Empty objects count as absent: debug records store `{}` for unset header maps. */
function present(value: unknown): boolean {
  if (value == null || value === '') return false
  if (typeof value === 'object' && Object.keys(value as object).length === 0)
    return false
  return true
}

/**
 * 原始数据各块，顺序即请求的实际流向：入站 → 出站 → 返回客户端。
 * 后端写入时已脱敏（Authorization / Cookie / 凭证形态字符串）。
 */
function sections(item: RequestLogItem): Section[] {
  const res = item.response ?? null
  const all: Section[] = [
    {
      id: 'inbound_body',
      label: translate('logs:inboundBody'),
      value: item.inbound_body,
    },
    {
      id: 'headers',
      label: translate('logs:inboundHeaders'),
      value: item.headers,
    },
    {
      id: 'outbound_body',
      label: translate('logs:outboundBody'),
      value: item.outbound_body,
    },
    {
      id: 'outbound_headers',
      label: translate(
        item.outbound_headers_source === 'cli_final'
          ? 'logs:finalOutboundHeaders'
          : 'logs:outboundHeaders'
      ),
      value:
        item.outbound_headers_source === 'unavailable'
          ? translate('logs:finalOutboundHeadersUnavailable')
          : item.outbound_headers,
      note:
        item.outbound_headers_source === 'cli_final'
          ? translate('logs:finalOutboundHeadersNote')
          : item.outbound_headers_source == null &&
              present(item.outbound_headers)
            ? translate('logs:historicalOutboundHeadersNote')
            : undefined,
    },
    {
      id: 'worker_envelope_headers',
      label: translate('logs:workerEnvelopeHeaders'),
      value: item.worker_envelope_headers,
    },
    {
      id: 'response_body',
      label: translate('logs:responseBody'),
      value: res?.body,
      note: res
        ? translate(
            res.truncated ? 'logs:bodyBytesTruncated' : 'logs:bodyBytes',
            { count: res.bytes }
          )
        : undefined,
    },
    {
      id: 'response_headers',
      label: translate('logs:responseHeaders'),
      value: res?.headers,
    },
    {
      id: 'hop_meta',
      label: translate('logs:chainMetadata'),
      value: item.hop_meta,
    },
    {
      id: 'cache_continuity',
      label: translate('logs:cacheContinuity'),
      value: item.cache_continuity,
    },
    {
      id: 'cache_prefix',
      label: translate('logs:cachePrefix'),
      value: item.cache_prefix,
    },
    {
      id: 'classifier',
      label: translate('logs:classifier'),
      value: item.classifier,
    },
  ]
  return all.filter((s) => present(s.value))
}

function CopyButton({ text }: { text: string }) {
  const { t: translate } = useTranslation('logs')

  const [copied, setCopied] = useState(false)
  return (
    <Button
      type='button'
      variant='ghost'
      size='sm'
      className='h-7 gap-1 px-2 text-xs'
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
    >
      {copied ? <Check className='h-3 w-3' /> : <Copy className='h-3 w-3' />}
      {copied ? translate('logs:copied') : translate('logs:copy')}
    </Button>
  )
}

/**
 * 「原始数据」页签：debug 采样记录（`/api/panel/request-logs/:id`）。
 * 只有 debug 模式落库的请求才有头/体；普通请求给出开启方式。
 */
export function RawDataTab({
  requestId,
  logMode,
}: {
  requestId: string | null
  logMode: 'normal' | 'debug' | null
}) {
  const { t: translate } = useTranslation('logs')

  const detail = useQuery(requestLogQueryOptions(requestId ?? '', !!requestId))
  const item = detail.data?.item as RequestLogItem | undefined
  const list = item ? sections(item) : []
  const [active, setActive] = useState<string | null>(null)

  if (!requestId) {
    return (
      <p className='text-sm text-muted-foreground'>
        {translate('logs:missingRequestId')}
      </p>
    )
  }
  if (detail.isLoading) {
    return (
      <p className='text-sm text-muted-foreground'>
        {translate('logs:loadingRawData')}
      </p>
    )
  }
  if (!list.length) {
    return (
      <div className='space-y-2 rounded-lg border border-dashed p-6 text-sm text-muted-foreground'>
        <p>
          {logMode === 'debug'
            ? translate('logs:debugDataUnavailable')
            : translate('logs:debugNotEnabled')}
        </p>
        <p className='text-xs'>
          <Trans
            ns='logs'
            i18nKey='debugSamplingHelp'
            values={{}}
            components={{ code: <code /> }}
          />
        </p>
      </div>
    )
  }

  const current = list.find((s) => s.id === active) ?? list[0]
  const text = pretty(current.value)
  return (
    <div className='space-y-3'>
      <div className='flex flex-wrap items-center gap-2 text-xs'>
        {item?.upstream_status != null && item.upstream_status !== '' ? (
          <Badge variant='outline' className='font-mono'>
            {translate('logs:upstreamStatusBadge', {
              status: String(item.upstream_status),
            })}
          </Badge>
        ) : null}
        {item?.response?.status != null ? (
          <Badge variant='outline' className='font-mono'>
            {translate('logs:responseStatusBadge', {
              status: item.response.status,
            })}
          </Badge>
        ) : null}
        {item?.api_key_presented ? (
          // 入站 Key 是攻击者可控的明文：只渲染掩码，不设 title、不提供复制。
          <Badge variant='outline' className='font-mono'>
            {translate('logs:inboundKeyBadge', {
              key: maskPresentedKey(item.api_key_presented),
            })}
          </Badge>
        ) : null}
      </div>
      <div className='flex flex-wrap gap-1'>
        {list.map((s) => (
          <button
            key={s.id}
            type='button'
            data-active={s.id === current.id}
            onClick={() => setActive(s.id)}
            className={cn(
              'cursor-pointer rounded-md border px-2.5 py-1 text-xs transition-colors',
              'hover:bg-muted/60 data-[active=true]:border-primary/50 data-[active=true]:bg-primary/10 data-[active=true]:text-primary'
            )}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div className='overflow-hidden rounded-lg border'>
        <div className='flex items-center justify-between border-b bg-muted/40 px-3 py-1'>
          <span className='text-xs text-muted-foreground'>
            {current.label}
            {current.note ? ` · ${current.note}` : ''}
          </span>
          <CopyButton text={text} />
        </div>
        <pre className='max-h-[55vh] overflow-auto bg-muted/20 p-3 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap'>
          {text}
        </pre>
      </div>
    </div>
  )
}
