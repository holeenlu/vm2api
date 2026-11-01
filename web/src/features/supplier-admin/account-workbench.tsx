import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { api } from '@/lib/api'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Main } from '@/components/layout/main'
import { AccountDetails } from '@/features/vendor/account-details'
import { AccountWorkbench } from '@/features/vendor/account-workbench'
import type { Resource } from '@/features/vendor/portal-model'
import { CredentialPanel } from '@/features/vm/credential-panel'
import { AdminAccountCreateForm } from './account-create-form'
import { ROOT, type Supplier } from './model'

export function AdminAccountWorkbench({
  initialVendor = 'all',
}: {
  initialVendor?: string
}) {
  const { t } = useTranslation('vendor')
  const navigate = useNavigate(),
    qc = useQueryClient()
  const [scope, setScope] = useState(initialVendor),
    [seconds, setSeconds] = useState(60)
  const [creating, setCreating] = useState(false),
    [selected, setSelected] = useState<Resource | null>(null),
    [authorizing, setAuthorizing] = useState<Resource | null>(null)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<Error | null>(null)
  const suppliers = useQuery({
    queryKey: ['supplier-admin', 'suppliers'],
    queryFn: () => api<Supplier[]>(ROOT),
  })
  const rows = useQuery({
    queryKey: ['supplier-admin', 'accounts', scope],
    queryFn: () =>
      api<Resource[]>(
        ROOT + '/accounts?archived=all&vendor_id=' + encodeURIComponent(scope)
      ),
    refetchInterval: seconds ? seconds * 1000 : false,
  })
  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['supplier-admin'] }),
      qc.invalidateQueries({ queryKey: ['vendor'] }),
      qc.invalidateQueries({ queryKey: ['panel', 'vms'] }),
    ])
  }
  const change = async (row: Resource, method: string, body?: unknown) => {
    setBusy(true)
    setError(null)
    try {
      await api(ROOT + '/accounts/' + row.id, {
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      await refresh()
      return true
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)))
      return false
    } finally {
      setBusy(false)
    }
  }
  const vmSettings = (row: Resource) => {
    if (row.telemetry?.vm_id)
      void navigate({ to: '/vm/$id', params: { id: row.telemetry.vm_id } })
  }
  return (
    <Main fluid>
      <AccountWorkbench
        rows={rows.data || []}
        admin
        apiBase={ROOT + '/accounts'}
        vendorId='super-admin'
        vendorName={t('allVisibleVendors')}
        scope={scope}
        scopes={[
          { id: 'all', name: t('allVisibleVendors') },
          ...(suppliers.data || []).map((v) => ({ id: v.id, name: v.name })),
        ]}
        loading={rows.isPending}
        error={error || rows.error || suppliers.error}
        busy={busy}
        updatedAt={rows.dataUpdatedAt}
        canManage
        canCreate
        canViewUsage
        refreshSeconds={seconds}
        onScope={setScope}
        onRefreshSeconds={setSeconds}
        onRefresh={refresh}
        onCreate={() => setCreating(true)}
        onDetail={setSelected}
        onAuthorize={setAuthorizing}
        onVmSettings={vmSettings}
        onSetStatus={(row, status) =>
          api(ROOT + '/accounts/' + row.id, {
            method: 'PATCH',
            body: JSON.stringify({ status }),
          })
        }
        onDelete={async (row) => {
          if (!(await change(row, 'DELETE'))) throw new Error(t('updateFailed'))
        }}
      />
      {creating && (
        <AdminAccountCreateForm
          suppliers={suppliers.data || []}
          initialVendor={scope}
          close={() => setCreating(false)}
          saved={refresh}
        />
      )}
      {selected && (
        <AccountDetails
          apiBase={ROOT + '/accounts'}
          resource={selected}
          canManage
          onClose={() => setSelected(null)}
          onChanged={() => void refresh()}
        />
      )}
      <Dialog
        open={!!authorizing}
        onOpenChange={(open) => {
          if (!open) setAuthorizing(null)
        }}
      >
        <DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-2xl'>
          <DialogHeader>
            <DialogTitle>{t('authorizeAccount')}</DialogTitle>
            <DialogDescription>
              {t('authorizeAccountDescription')}
            </DialogDescription>
          </DialogHeader>
          {authorizing && (
            <CredentialPanel
              vm={{
                id: authorizing.telemetry?.vm_id || '',
                name: authorizing.name,
                platform: String(authorizing.config.platform),
                family:
                  authorizing.config.platform === 'openai' ? 'codex' : 'claude',
                can_import_credential: true,
              }}
              initialKind={
                authorizing.config.auth_method === 'apikey'
                  ? 'apikey'
                  : authorizing.config.auth_method === 'setup-token'
                    ? 'setup-token'
                    : 'oauth'
              }
              initialCodexMode={
                authorizing.config.authorization_mode === 'codex_account_file'
                  ? 'json'
                  : 'oauth'
              }
              showConvert={false}
              onCommitted={() => {
                setAuthorizing(null)
                void refresh()
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </Main>
  )
}
