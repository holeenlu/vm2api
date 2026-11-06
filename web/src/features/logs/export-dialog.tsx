import { useState, useRef, useEffect } from 'react'
import { t as translate } from '@/i18n'
import { Download } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ERROR_CLASS_IDS, ERROR_CLASS_META } from '@/lib/log-mute'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'

export type ExportScope = 'current' | 'all' | 'errors'
export type ExportWindow = '' | '1h' | '6h' | '24h' | '7d'

export type ExportOptions = {
  format: 'jsonl' | 'csv'
  scope: ExportScope
  /** 仅 scope='errors' 时生效；空 = 全部错误类。 */
  errorClass: string
  window: ExportWindow
  includeMuted: boolean
  limit: number
}

const WINDOWS: { value: ExportWindow; label: string }[] = [
  {
    value: '',
    get label() {
      return translate('logs:allTime')
    },
  },
  {
    value: '1h',
    get label() {
      return translate('logs:lastHour')
    },
  },
  {
    value: '6h',
    get label() {
      return translate('logs:lastSixHours')
    },
  },
  {
    value: '24h',
    get label() {
      return translate('logs:lastDay')
    },
  },
  {
    value: '7d',
    get label() {
      return translate('logs:lastWeek')
    },
  },
]

const LIMITS = [500, 2000, 5000]

function ScopeOption({
  value,
  title,
  desc,
  children,
}: {
  value: ExportScope
  title: string
  desc?: string
  children?: React.ReactNode
}) {
  useTranslation('logs')

  return (
    <Label className='flex cursor-pointer items-start gap-2.5 rounded-lg border border-border/60 p-3 font-normal transition-colors hover:border-border has-data-[state=checked]:border-primary/50 has-data-[state=checked]:bg-primary/5'>
      <RadioGroupItem value={value} className='mt-0.5' />
      <span className='min-w-0 flex-1 space-y-1'>
        <span className='block text-sm leading-none font-medium'>{title}</span>
        {desc ? (
          <span className='block text-xs leading-snug text-muted-foreground'>
            {desc}
          </span>
        ) : null}
        {children}
      </span>
    </Label>
  )
}

/**
 * 导出筛选对话框：JSONL/CSV 共用一套范围选择。
 * 后端 `GET /request-logs/export` 上限 5000 条，超出按最新截断（响应头回报）。
 */
export function ExportDialog({
  open,
  onOpenChange,
  currentSummary,
  onExport,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 「跟随当前筛选」的说明文案，由页面根据当前筛选态拼出。 */
  currentSummary: string
  onExport: (opts: ExportOptions, signal?: AbortSignal) => Promise<void>
}) {
  const { t: translate } = useTranslation('logs')

  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => controller.current?.abort(), [])
  const [format, setFormat] = useState<'jsonl' | 'csv'>('jsonl')
  const [scope, setScope] = useState<ExportScope>('current')
  const [errorClass, setErrorClass] = useState('')
  const [window, setWindow] = useState<ExportWindow>('')
  const [includeMuted, setIncludeMuted] = useState(false)
  const [limit, setLimit] = useState(5000)
  const [exporting, setExporting] = useState(false)

  async function handleConfirm() {
    controller.current = new AbortController()
    setExporting(true)
    try {
      await onExport(
        { format, scope, errorClass, window, includeMuted, limit },
        controller.current.signal
      )
      onOpenChange(false)
    } catch {
      /* The caller reports export errors. */
    } finally {
      setExporting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) controller.current?.abort()
        onOpenChange(o)
      }}
    >
      <DialogContent className='sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>{translate('logs:exportLogs')}</DialogTitle>
          <DialogDescription>
            {translate('logs:exportLimitHint', {
              count: LIMITS[LIMITS.length - 1],
            })}
          </DialogDescription>
        </DialogHeader>
        <div className='space-y-4'>
          <div className='space-y-2'>
            <div className='text-xs font-medium text-muted-foreground'>
              {translate('logs:scope')}
            </div>
            <RadioGroup
              value={scope}
              onValueChange={(v) => setScope(v as ExportScope)}
              className='gap-2'
            >
              <ScopeOption
                value='current'
                title={translate('logs:currentFilters')}
                desc={currentSummary}
              />
              <ScopeOption
                value='all'
                title={translate('logs:allLogs')}
                desc={translate('logs:exportAllHint')}
              />
              <ScopeOption value='errors' title={translate('logs:errorsOnly')}>
                {scope === 'errors' ? (
                  <Select
                    value={errorClass || 'none'}
                    onValueChange={(v) => setErrorClass(v === 'none' ? '' : v)}
                  >
                    <SelectTrigger
                      size='sm'
                      className='mt-1.5 w-44'
                      onClick={(e) => e.preventDefault()}
                    >
                      <SelectValue placeholder={translate('logs:errorClass')} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='none'>
                        {translate('logs:allErrorClasses')}
                      </SelectItem>
                      {ERROR_CLASS_IDS.map((c) => (
                        <SelectItem key={c} value={c}>
                          {ERROR_CLASS_META[c].label}（{c}）
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}
              </ScopeOption>
            </RadioGroup>
          </div>
          <div className='grid grid-cols-2 gap-3'>
            <div className='space-y-2'>
              <div className='text-xs font-medium text-muted-foreground'>
                {translate('logs:timeWindow')}
              </div>
              <Select
                value={window || 'all'}
                onValueChange={(v) =>
                  setWindow(v === 'all' ? '' : (v as ExportWindow))
                }
              >
                <SelectTrigger size='sm' className='w-full'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WINDOWS.map((w) => (
                    <SelectItem key={w.value || 'all'} value={w.value || 'all'}>
                      {w.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className='space-y-2'>
              <div className='text-xs font-medium text-muted-foreground'>
                {translate('logs:recordLimit')}
              </div>
              <Select
                value={String(limit)}
                onValueChange={(v) => setLimit(Number(v))}
              >
                <SelectTrigger size='sm' className='w-full'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LIMITS.map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {scope !== 'all' ? (
            <Label className='flex cursor-pointer items-center justify-between gap-3 font-normal'>
              <span className='text-sm'>{translate('logs:includeMuted')}</span>
              <Switch
                checked={includeMuted}
                onCheckedChange={setIncludeMuted}
              />
            </Label>
          ) : null}
          <div className='space-y-2'>
            <div className='text-xs font-medium text-muted-foreground'>
              {translate('logs:format')}
            </div>
            <RadioGroup
              value={format}
              onValueChange={(v) => setFormat(v as 'jsonl' | 'csv')}
              className='flex gap-4'
            >
              <Label className='flex cursor-pointer items-center gap-2 font-normal'>
                <RadioGroupItem value='jsonl' />
                <span className='text-sm'>{translate('logs:jsonl')}</span>
              </Label>
              <Label className='flex cursor-pointer items-center gap-2 font-normal'>
                <RadioGroupItem value='csv' />
                <span className='text-sm'>{translate('logs:csv')}</span>
              </Label>
            </RadioGroup>
          </div>
        </div>
        <DialogFooter>
          <Button
            variant='outline'
            onClick={() => {
              controller.current?.abort()
              onOpenChange(false)
            }}
          >
            {translate('logs:cancel')}
          </Button>
          <Button onClick={() => void handleConfirm()} loading={exporting}>
            <Download className='size-4' />
            {translate('logs:export')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
