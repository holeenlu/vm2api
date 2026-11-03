import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { Vm } from '@/types/panel-vm'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { VmBulkEdit } from './vm-bulk-edit'
import { readPendingBulk, type BulkRequest } from './vm-bulk-model'

type Selection = {
  ids: string[]
  vms: Vm[]
  toggle: (id: string) => void
  all: () => void
}
const Context = createContext<Selection | null>(null)
export const useVmSelection = () => useContext(Context)
export function VmSelectAll() {
  const selection = useVmSelection()
  const { t } = useTranslation('vm')
  if (!selection) return null
  const count = selection.vms.filter((x) => selection.ids.includes(x.id)).length
  return (
    <Checkbox
      checked={
        count === selection.vms.length && count > 0
          ? true
          : count > 0
            ? 'indeterminate'
            : false
      }
      aria-label={t('vmBulk.selectAll', { count: selection.vms.length })}
      onCheckedChange={selection.all}
    />
  )
}
export function VmSelectionCheckbox({ vm }: { vm: Vm }) {
  const selection = useVmSelection()
  const { t } = useTranslation('vm')
  // 只对可编辑集合显示（如已归档的 Gateway 账号不参与批量编辑）。
  if (!selection || !selection.vms.some((x) => x.id === vm.id)) return null
  return (
    <span
      className='inline-flex items-center p-1'
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <Checkbox
        checked={selection.ids.includes(vm.id)}
        aria-label={t('vmBulk.selectOne', { name: vm.name || vm.id })}
        onCheckedChange={() => selection.toggle(vm.id)}
      />
    </span>
  )
}
export function VmSelectionProvider({
  vms,
  enabled,
  scopeKey,
  renderBulkEdit,
  children,
}: {
  vms: Vm[]
  enabled: boolean
  scopeKey: string
  /** 非 VM 资源的批量编辑器；提供时不使用 VM 批量编辑及其断点续改。 */
  renderBulkEdit?: (props: {
    ids: string[]
    onClose: () => void
    onSaved: (saved: string[]) => void
  }) => ReactNode
  children: ReactNode
}) {
  const { t } = useTranslation('vm')
  const [ids, setIds] = useState<string[]>([])
  const [pending, setPending] = useState<BulkRequest | null>(() =>
    renderBulkEdit ? null : readPendingBulk()
  )
  const [editing, setEditing] = useState<string[] | null>(null)
  const scope = useRef(scopeKey)
  const barRef = useRef<HTMLDivElement>(null)
  const visibleIds = vms.map((v) => v.id)
  const visibleKey = JSON.stringify(visibleIds.slice().sort())
  useEffect(() => {
    if (scope.current !== scopeKey) {
      scope.current = scopeKey
      if (ids.length) toast.info(t('vmBulk.selectionCleared'))
      setIds([])
    } else {
      const existing = new Set(JSON.parse(visibleKey) as string[])
      if (ids.some((id) => !existing.has(id))) {
        setIds(ids.filter((id) => existing.has(id)))
        toast.info(t('vmBulk.selectionPruned'))
      }
    }
  }, [scopeKey, visibleKey, ids, t])
  const selectAll = () => {
    if (vms.length > 500) {
      toast.error(t('vmBulk.limit'))
      return
    }
    setIds(vms.length === ids.length ? [] : visibleIds)
  }
  const toggle = (id: string) => {
    if (!ids.includes(id) && ids.length >= 500) {
      toast.error(t('vmBulk.limit'))
      return
    }
    setIds(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id])
  }
  return (
    <Context.Provider
      value={enabled ? { ids, vms, toggle, all: selectAll } : null}
    >
      {enabled ? (
        <div
          ref={barRef}
          className='sticky top-0 z-20 mb-3 flex flex-wrap items-center gap-2 bg-background py-1 text-sm'
        >
          {pending ? (
            <Button
              size='sm'
              variant='outline'
              onClick={() => setEditing(pending.items.map((x) => x.id))}
            >
              {t('vmBulk.resume')}
            </Button>
          ) : null}
          <VmSelectAll />
          <span>{t('vmBulk.selectAll', { count: vms.length })}</span>
          {ids.length ? (
            <div
              role='toolbar'
              aria-label={t('vmBulk.title')}
              className='flex flex-1 flex-wrap items-center gap-3 rounded-lg border bg-muted p-2'
            >
              <span aria-live='polite'>
                {t('vmBulk.selected', { count: ids.length })}
              </span>
              <Button size='sm' variant='ghost' onClick={() => setIds([])}>
                {t('vmBulk.clear')}
              </Button>
              <Button
                data-bulk-edit-trigger
                className='ms-auto'
                size='sm'
                onClick={() => {
                  const saved = renderBulkEdit ? null : readPendingBulk()
                  setPending(saved)
                  setEditing(saved ? saved.items.map((x) => x.id) : [...ids])
                }}
              >
                {t('vmBulk.edit')}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {children}
      {enabled && editing && renderBulkEdit
        ? renderBulkEdit({
            ids: editing,
            onClose: () => setEditing(null),
            onSaved: (saved) => {
              setIds((current) => current.filter((id) => !saved.includes(id)))
              setEditing(null)
            },
          })
        : null}
      {enabled && editing && !renderBulkEdit ? (
        <VmBulkEdit
          ids={editing}
          resume={pending}
          onReturnFocus={() =>
            (
              barRef.current?.querySelector<HTMLButtonElement>(
                '[data-bulk-edit-trigger]'
              ) || barRef.current?.querySelector<HTMLButtonElement>('button')
            )?.focus()
          }
          onClose={() => {
            setPending(readPendingBulk())
            setEditing(null)
          }}
          onSaved={(saved) => {
            setPending(null)
            setIds((current) => current.filter((id) => !saved.includes(id)))
            setEditing(null)
          }}
        />
      ) : null}
    </Context.Provider>
  )
}
