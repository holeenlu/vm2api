import { useEffect, useRef, useState } from 'react'
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
import { vmQueryOptions } from '@/features/vm/queries'
import { PackageFacts } from '@/features/vm/vm-package-view'

function packageFilename(id: string) {
  const stamp = systemDateTime().replace(/[-:T]/g, '')
  return `vm-package-${id || 'slot'}-${stamp}.json`
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

export function VmPackageButton({
  vmId,
  className,
}: {
  vmId: string
  className?: string
}) {
  useTranslation('vm')

  const me = useQuery(meQueryOptions())
  const [open, setOpen] = useState(false)
  if (me.data?.role !== 'super_admin') return null
  return (
    <>
      <Button
        size='sm'
        variant='outline'
        className={className}
        onClick={() => setOpen(true)}
      >
        <Trans
          ns='vm'
          i18nKey='vmPackageDialog.completeVirtualMachineInformation'
        />
      </Button>
      <VmPackageDialog vmId={vmId} open={open} onOpenChange={setOpen} />
    </>
  )
}

export function VmPackageDialog({
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
  const fileRef = useRef<HTMLInputElement>(null)
  const [text, setText] = useState('')
  const [parseError, setParseError] = useState('')
  const pack = useQuery({
    queryKey: ['panel', 'vm-package', vmId] as const,
    queryFn: () =>
      api<Record<string, unknown>>(
        `/api/panel/vms/${encodeURIComponent(vmId)}/package`
      ),
    enabled: open,
    gcTime: 0,
  })

  useEffect(() => {
    if (!pack.data) return
    setText(JSON.stringify(pack.data, null, 2))
  }, [pack.data])

  const save = useMutation({
    mutationFn: (body: unknown) =>
      api(`/api/panel/vms/${encodeURIComponent(vmId)}/package`, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    onSuccess: async () => {
      toast.success(tVm('vm:vmPackageDialog.slotOverwritten'))
      await qc.invalidateQueries({ queryKey: vmQueryOptions(vmId).queryKey })
      qc.removeQueries({ queryKey: ['panel', 'vm-package', vmId] })
      onOpenChange(false)
    },
    onError: (e: Error) =>
      toast.error(e.message || tVm('vm:vmPackageDialog.overwriteFailed')),
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
      <DialogContent className='gap-5 sm:max-w-4xl'>
        <DialogHeader>
          <DialogTitle className='text-xl tracking-tight'>
            <Trans
              ns='vm'
              i18nKey='vmPackageDialog.completeVirtualMachineInformation'
            />
          </DialogTitle>
          <DialogDescription className='max-w-[68ch]'>
            <Trans
              ns='vm'
              i18nKey='vmPackageDialog.completePackageForDownloadTheJSONToExportIt'
              values={{ vmId: vmId }}
            />
          </DialogDescription>
        </DialogHeader>
        {pack.isLoading ? (
          <p className='py-8 text-center text-sm text-muted-foreground'>
            <Trans ns='vm' i18nKey='credentialEditor.loading' />
          </p>
        ) : pack.error ? (
          <p className='py-8 text-center text-sm text-destructive'>
            {(pack.error as Error).message ||
              tVm('vm:vmPackageDialog.failedToReadPackageData')}
          </p>
        ) : (
          <div className='grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]'>
            <div className='rounded-xl border bg-card p-4'>
              {parseError ? (
                <p className='text-xs text-destructive'>
                  {parseError.startsWith('vm:') ? tVm(parseError) : parseError}
                </p>
              ) : (
                <PackageFacts text={text} className='sm:grid-cols-1' />
              )}
            </div>
            <div className='min-w-0 space-y-2'>
              <Textarea
                className='h-80 font-mono text-[13px] leading-relaxed'
                spellCheck={false}
                value={text}
                disabled={busy}
                aria-label={tVm('vm:vmPackageDialog.virtualMachinePackageJSON')}
                onChange={(e) => {
                  setText(e.target.value)
                  if (parseError) setParseError('')
                }}
              />
              <p className='text-xs text-muted-foreground'>
                <Trans
                  ns='vm'
                  i18nKey='vmPackageDialog.containsPlaintextCredentialsAndProxyPasswordsShownOnlyIn'
                />
              </p>
            </div>
          </div>
        )}
        <DialogFooter className='gap-2 sm:justify-between'>
          <div className='flex flex-wrap gap-2'>
            <input
              ref={fileRef}
              type='file'
              accept='application/json,.json'
              className='hidden'
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (!file) return
                file
                  .text()
                  .then((raw) => {
                    setText(raw)
                    setParseError('')
                  })
                  .catch(() =>
                    setParseError('vm:vmPackageDialog.fileReadFailed')
                  )
              }}
            />
            <Button
              size='sm'
              variant='ghost'
              disabled={!text || busy}
              onClick={() => downloadJson(packageFilename(vmId), text)}
            >
              <Trans ns='vm' i18nKey='vmPackageDialog.download' />
            </Button>
            <Button
              size='sm'
              variant='ghost'
              disabled={busy || !!pack.error}
              onClick={() => fileRef.current?.click()}
            >
              <Trans ns='vm' i18nKey='credentialPanel.import' />
            </Button>
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
                ? tVm('vm:vmPackageDialog.overwriting')
                : tVm('vm:vmPackageDialog.overwriteThisSlot')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
