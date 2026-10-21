import type { ApiEndpoint } from '@/types/panel-api-endpoints'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'

// Shared with group resource selection; presentation follows the upstream API page.
export function EndpointCard({
  endpoint,
  busy,
  onEdit,
  onToggle,
  onDelete,
  onGroups,
  selection,
}: {
  endpoint: ApiEndpoint
  busy: boolean
  onEdit: () => void
  onToggle?: () => void
  onDelete?: () => void
  onGroups?: () => void
  selection?: { checked: boolean; onChange: (checked: boolean) => void }
}) {
  const keys = endpoint.api_key_entries || []
  const ready = keys.filter(
    (entry) => !entry.disabled && !entry.cooldown_until
  ).length
  const models = endpoint.models || []
  return (
    <Card
      className={cn(
        'cursor-pointer transition-colors',
        !selection && 'h-full',
        endpoint.disabled ? 'bg-muted/60' : 'hover:bg-accent/40',
        selection?.checked && 'border-primary bg-primary/5'
      )}
      onClick={onEdit}
    >
      <CardContent className='space-y-3'>
        <div className='flex items-start justify-between gap-2'>
          {selection && (
            <Checkbox
              className='mt-0.5'
              aria-label={`选择 ${endpoint.name || endpoint.id}`}
              checked={selection.checked}
              onClick={(event) => event.stopPropagation()}
              onCheckedChange={(checked) =>
                selection.onChange(checked === true)
              }
            />
          )}
          <div className='min-w-0 flex-1'>
            <div className='flex items-center gap-1.5 truncate font-medium'>
              <span className='truncate'>{endpoint.name || 'api'}</span>
              <Badge variant='outline' className='shrink-0 font-normal'>
                {kindLabel(endpoint.kind)}
              </Badge>
            </div>
            <p className='truncate font-mono text-xs text-muted-foreground'>
              {endpoint.base_url || '未填地址'}
              {endpoint.prefix ? ` · prefix ${endpoint.prefix}` : ''}
            </p>
          </div>
          {endpoint.disabled ? (
            <span className='shrink-0 text-xs text-muted-foreground'>
              已停用
            </span>
          ) : null}
        </div>
        {onGroups && (
          <div className='flex flex-wrap items-center gap-2 text-xs'>
            {endpoint.groups?.map((g) => (
              <Badge key={g.id} variant='outline'>
                {g.name}
              </Badge>
            ))}
            {!endpoint.groups?.length && (
              <span className='text-amber-500'>未关联分组</span>
            )}
            <Button
              size='sm'
              variant='outline'
              onClick={(e) => {
                e.stopPropagation()
                onGroups()
              }}
            >
              分配给分组
            </Button>
          </div>
        )}
        <div className='flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground'>
          <span>
            {ready}/{keys.length} key 可用
          </span>
          <span>{models.length} 模型</span>
          {endpoint.disable_cooling ? <span>冷却关</span> : null}
          {endpoint.priority ? <span>优先 {endpoint.priority}</span> : null}
          {endpoint.protocol !== 'openai' ? (
            <span>
              {endpoint.auth_scheme === 'authorization_bearer'
                ? 'Bearer'
                : 'x-api-key'}
            </span>
          ) : null}
        </div>
        {models.length ? (
          <div className='flex flex-wrap gap-1'>
            {models.map((model) => (
              <Badge key={`${model.name}:${model.alias}`} variant='secondary'>
                {model.alias}
              </Badge>
            ))}
          </div>
        ) : null}
        <div className='flex flex-wrap gap-1 border-t pt-2'>
          <Button
            size='sm'
            variant='ghost'
            onClick={(event) => {
              event.stopPropagation()
              onEdit()
            }}
          >
            编辑
          </Button>
          {onToggle && (
            <Button
              size='sm'
              variant='ghost'
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation()
                onToggle()
              }}
            >
              {endpoint.disabled ? '启用' : '停用'}
            </Button>
          )}
          {onDelete && (
            <Button
              size='sm'
              variant='destructive'
              onClick={(event) => {
                event.stopPropagation()
                onDelete()
              }}
            >
              删除
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function kindLabel(kind: ApiEndpoint['kind']): string {
  if (kind === 'claude') return 'Claude 官方'
  if (kind === 'openai') return 'OpenAI 官方'
  return '自定义'
}
