import type { ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'
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
import { Textarea } from '@/components/ui/textarea'
import {
  type CatalogMode,
  type ModelPolicy,
  type PolicyDefaults,
  context1mWhitelist,
  isCatalogMode,
} from './policy'

type Props = {
  pol: ModelPolicy
  onCatalogMode: (mode: CatalogMode) => void
  onDefaults: (patch: Partial<PolicyDefaults>) => void
}

export function ModelAdvanced({ pol, onCatalogMode, onDefaults }: Props) {
  const { t } = useTranslation('models')
  const defs = pol.defaults || {}
  const mode = isCatalogMode(pol.catalog_mode)
    ? pol.catalog_mode
    : 'worker_intersect_policy'
  const whitelistText = context1mWhitelist(pol).join('\n')

  return (
    <Collapsible className='mt-4 rounded-lg border border-border/70 bg-card'>
      <CollapsibleTrigger className='flex w-full cursor-pointer items-center justify-between px-3 py-2.5 text-left text-sm font-medium transition-colors duration-200 hover:bg-muted/40'>
        <span>{t('models:advancedTitle')}</span>
        <ChevronDown className='size-4 text-muted-foreground' />
      </CollapsibleTrigger>
      <CollapsibleContent className='space-y-3 border-t border-border/40 px-3 py-3 text-sm'>
        <Row label={t('models:catalogMode')}>
          <Select
            value={mode}
            onValueChange={(v) => {
              if (isCatalogMode(v)) onCatalogMode(v)
            }}
          >
            <SelectTrigger className='h-8 w-[260px]'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='worker_intersect_policy'>
                {t('models:workerIntersectPolicy')}
              </SelectItem>
              <SelectItem value='worker_only'>
                {t('models:workerOnly')}
              </SelectItem>
              <SelectItem value='policy_only'>
                {t('models:policyOnly')}
              </SelectItem>
            </SelectContent>
          </Select>
        </Row>
        <Row label={t('models:filter1mBeta')}>
          <div className='flex items-center gap-2'>
            <Switch
              checked={defs.strip_context_1m !== false}
              onCheckedChange={(on) => onDefaults({ strip_context_1m: on })}
              aria-label={t('models:filter1mBeta')}
            />
            <span className='text-xs text-muted-foreground'>
              {defs.strip_context_1m !== false
                ? t('models:on')
                : t('models:off')}
            </span>
          </div>
        </Row>
        <div className='space-y-1'>
          <Label>{t('models:fallbackWildcard')}</Label>
          <Textarea
            className='min-h-[72px] font-mono text-xs'
            rows={3}
            value={whitelistText}
            placeholder={t('models:fallbackPlaceholder')}
            onChange={(e) =>
              onDefaults({
                context_1m_whitelist: e.target.value
                  .split(/[\n,]+/)
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
          />
          <p className='text-xs text-muted-foreground'>
            {t('models:fallbackDescription')}
          </p>
        </div>
        <Row label={t('models:normalizeThinking')}>
          <div className='flex items-center gap-2'>
            <Switch
              checked={defs.normalize_thinking !== false}
              onCheckedChange={(on) => onDefaults({ normalize_thinking: on })}
            />
            <span className='text-xs text-muted-foreground'>
              {defs.normalize_thinking !== false
                ? t('models:on')
                : t('models:off')}
            </span>
          </div>
        </Row>
        <Row label={t('models:fallbackBudget')}>
          <Input
            className='h-8 w-[140px]'
            type='number'
            value={defs.thinking_fallback_budget ?? 4096}
            onChange={(e) =>
              onDefaults({
                thinking_fallback_budget: Number(e.target.value) || 0,
              })
            }
          />
        </Row>
        <Row label={t('models:maxTokensDefault')}>
          <Input
            className='h-8 w-[140px]'
            type='number'
            value={defs.max_tokens ?? 16384}
            onChange={(e) =>
              onDefaults({ max_tokens: Number(e.target.value) || 0 })
            }
          />
        </Row>
      </CollapsibleContent>
    </Collapsible>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  useTranslation('models')

  return (
    <div className='flex flex-wrap items-center gap-3'>
      <span className='w-32 shrink-0 text-muted-foreground'>{label}</span>
      {children}
    </div>
  )
}
