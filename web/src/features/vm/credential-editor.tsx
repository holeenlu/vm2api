import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation, Trans } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { systemDateTime } from '@/lib/system-time'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { meQueryOptions } from '@/features/auth/queries'
import { vmCredentialQueryOptions, vmQueryOptions } from '@/features/vm/queries'

function credExportFilename(id: string) {
  const stamp = systemDateTime().replace(/[-:T]/g, '')
  return `sub2api-account-${id || 'slot'}-${stamp}.json`
}

function downloadJson(name: string, text: string) {
  const url = URL.createObjectURL(
    new Blob([text], { type: 'application/json' })
  )
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * The one place in the panel that shows credential plaintext.
 * Gated on role==='admin' and only fetched once the dialog is opened —
 * never preloaded with the detail page. See spec/frontend/api-contract.md.
 */
export function CredentialEditorButton({ vmId }: { vmId: string }) {
  useTranslation('vm')

  const me = useQuery(meQueryOptions())
  const [open, setOpen] = useState(false)
  if (me.data?.role !== 'super_admin') return null
  return (
    <>
      <Button size='sm' variant='outline' onClick={() => setOpen(true)}>
        <Trans ns='vm' i18nKey='credentialEditor.editCredentials' />
      </Button>
      {open ? (
        <CredentialDialog vmId={vmId} open={open} onOpenChange={setOpen} />
      ) : null}
    </>
  )
}

function CredentialDialog({
  vmId,
  open,
  onOpenChange,
}: {
  vmId: string
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const { t: tVm } = useTranslation('vm')

  const qc = useQueryClient()
  const [text, setText] = useState('')
  const [parseError, setParseError] = useState('')

  const cred = useQuery(vmCredentialQueryOptions(vmId, open))

  useEffect(() => {
    if (!cred.data) return
    setText(JSON.stringify(cred.data.export ?? cred.data, null, 2))
  }, [cred.data])

  const save = useMutation({
    mutationFn: (body: unknown) =>
      api(`/api/panel/vms/${encodeURIComponent(vmId)}/oauth/credential`, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      toast.success(
        tVm(
          'vm:credentialEditor.credentialsSavedThisEndpointDoesNotTriggerOfficialSetup'
        )
      )
      qc.invalidateQueries({ queryKey: vmQueryOptions(vmId).queryKey })
      qc.removeQueries({ queryKey: vmCredentialQueryOptions(vmId).queryKey })
      onOpenChange(false)
    },
    // never echo the payload back — only the server's own message
    onError: (e: Error) =>
      toast.error(
        e.message || tVm('vm:credentialEditor.failedToWriteCredentials')
      ),
  })

  const submit = () => {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      setParseError('vm:credentialEditor.invalidJSONCheckTheFormatAndTryAgain')
      return
    }
    setParseError('')
    save.mutate(parsed)
  }

  const busy = save.isPending

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!busy) {
          if (!v) setText('')
          onOpenChange(v)
        }
      }}
    >
      <DialogContent className='sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>
            <Trans ns='vm' i18nKey='credentialEditor.editSlotCredentials' />
          </DialogTitle>
          <DialogDescription>
            <Trans
              ns='vm'
              i18nKey='credentialEditor.sub2apiAccountJSONWithAtLeastAccessTokenOr'
            />
          </DialogDescription>
        </DialogHeader>

        {cred.isLoading ? (
          <p className='py-8 text-center text-sm text-muted-foreground'>
            <Trans ns='vm' i18nKey='credentialEditor.loading' />
          </p>
        ) : cred.error ? (
          <p className='py-8 text-center text-sm text-destructive'>
            {(cred.error as Error).message ||
              tVm('vm:credentialEditor.failedToReadCredentials')}
          </p>
        ) : (
          <div className='space-y-2'>
            <Textarea
              className='h-72 font-mono text-xs'
              spellCheck={false}
              value={text}
              disabled={busy}
              onChange={(e) => {
                setText(e.target.value)
                if (parseError) setParseError('')
              }}
            />
            {parseError ? (
              <p className='text-xs text-destructive'>
                {parseError.startsWith('vm:') ? tVm(parseError) : parseError}
              </p>
            ) : (
              <p className='text-xs text-muted-foreground'>
                <Trans
                  ns='vm'
                  i18nKey='credentialEditor.source'
                  values={{
                    value: cred.data?.source || '—',
                    value1: cred.data?.has_token
                      ? tVm('vm:credentialEditor.activeTokenPresent')
                      : tVm('vm:credentialEditor.noToken'),
                  }}
                />
              </p>
            )}
          </div>
        )}

        <DialogFooter className='gap-2 sm:justify-between'>
          <div className='flex gap-2'>
            <Button
              size='sm'
              variant='ghost'
              disabled={!text || busy}
              onClick={() => {
                navigator.clipboard
                  .writeText(text)
                  .then(() =>
                    toast.success(tVm('vm:credentialEditor.copiedToClipboard'))
                  )
                  .catch(() =>
                    toast.error(tVm('vm:credentialEditor.copyFailed'))
                  )
              }}
            >
              <Trans ns='vm' i18nKey='credentialEditor.copy' />
            </Button>
            <Button
              size='sm'
              variant='ghost'
              disabled={!text || busy}
              onClick={() => downloadJson(credExportFilename(vmId), text)}
            >
              <Trans ns='vm' i18nKey='credentialEditor.downloadJSON' />
            </Button>
          </div>
          <div className='flex gap-2'>
            <Button
              size='sm'
              variant='outline'
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              <Trans ns='vm' i18nKey='authSchemeEditor.cancel' />
            </Button>
            <Button size='sm' disabled={!text || busy} onClick={submit}>
              {busy
                ? tVm('vm:codexCredentialPanel.writing')
                : tVm('vm:credentialEditor.saveCredentials')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
