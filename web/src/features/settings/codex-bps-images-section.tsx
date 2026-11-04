import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

export type BpsImages = {
  policy?: string
  max_images?: number
  max_image_mib?: number
  max_total_mib?: number
  warning_remaining?: number
  compact_reserve?: number
}

const POLICIES = ['auto_compact', 'warn', 'off'] as const

type NumberField = Exclude<keyof BpsImages, 'policy'>

const DEFAULTS: Required<BpsImages> = {
  policy: 'auto_compact',
  max_images: 20,
  max_image_mib: 32,
  max_total_mib: 64,
  warning_remaining: 8,
  compact_reserve: 3,
}

// 字段上限与控制面 normalizeCodexBpsImages 一致；提醒与预留必须小于张数上限。
function bounds(field: NumberField, maxImages: number): [number, number] {
  switch (field) {
    case 'max_images':
      return [1, 200]
    case 'max_image_mib':
      return [1, 32]
    case 'max_total_mib':
      return [1, 64]
    default:
      return [0, Math.max(0, maxImages - 1)]
  }
}

// BPS 图片策略（routing.codex.bps_images），由 Gateway Worker 执行。
export function CodexBpsImagesSettings({
  value,
  onChange,
  disabled,
}: {
  value: BpsImages
  onChange: (next: BpsImages) => void
  disabled: boolean
}) {
  const { t } = useTranslation('settings')
  const current = { ...DEFAULTS, ...value }
  const [drafts, setDrafts] = useState<Record<NumberField, string>>({
    max_images: String(current.max_images),
    max_image_mib: String(current.max_image_mib),
    max_total_mib: String(current.max_total_mib),
    warning_remaining: String(current.warning_remaining),
    compact_reserve: String(current.compact_reserve),
  })
  const fields: NumberField[] =
    current.policy === 'off'
      ? ['max_images', 'max_image_mib', 'max_total_mib']
      : [
          'max_images',
          'max_image_mib',
          'max_total_mib',
          'warning_remaining',
          'compact_reserve',
        ]
  const parse = (field: NumberField, raw: string) => {
    const n = Number(raw)
    const [min, max] = bounds(field, current.max_images)
    return Number.isInteger(n) && n >= min && n <= max ? n : null
  }
  return (
    <div className='space-y-3 py-3'>
      <div className='space-y-2'>
        <Label htmlFor='codex-bps-image-policy'>
          {t('codexBps.images.policy')}
        </Label>
        <Select
          value={current.policy}
          disabled={disabled}
          onValueChange={(policy) => onChange({ ...current, policy })}
        >
          <SelectTrigger id='codex-bps-image-policy' className='min-h-11'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {POLICIES.map((policy) => (
              <SelectItem key={policy} value={policy}>
                {t(`codexBps.images.policies.${policy}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className='text-xs text-muted-foreground'>
          {t(`codexBps.images.policyHelp.${current.policy}`)}
        </p>
      </div>
      <div className='grid gap-3 sm:grid-cols-2'>
        {fields.map((field) => {
          const invalid = parse(field, drafts[field]) === null
          return (
            <div key={field} className='space-y-2'>
              <Label htmlFor={`codex-bps-image-${field}`}>
                {t(`codexBps.images.${field}`)}
              </Label>
              <Input
                id={`codex-bps-image-${field}`}
                inputMode='numeric'
                value={drafts[field]}
                disabled={disabled}
                aria-invalid={invalid}
                onChange={(event) => {
                  const raw = event.target.value
                  setDrafts((prev) => ({ ...prev, [field]: raw }))
                  const next = parse(field, raw)
                  if (next !== null) onChange({ ...current, [field]: next })
                }}
              />
              <p className='text-xs text-muted-foreground'>
                {t(`codexBps.images.${field}Help`)}
              </p>
            </div>
          )
        })}
      </div>
    </div>
  )
}
