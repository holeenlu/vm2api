import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { copyText } from '@/lib/clipboard'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

export type RevealedKey = {
  titleKey: 'keys:copyKey' | 'keys:title'
  name?: string
  id?: string
  key: string
}

export function KeyRevealDialog({
  value,
  onClose,
}: {
  value: RevealedKey | null
  onClose: () => void
}) {
  const { t } = useTranslation('keys')

  const plain = value?.key || ''
  const fieldRef = useRef<HTMLTextAreaElement>(null)

  function selectKey() {
    fieldRef.current?.focus()
    fieldRef.current?.select()
  }

  async function copy() {
    if (!plain) {
      toast.error(t('keys:noKeyToCopy'))
      return
    }
    if (await copyText(plain)) {
      toast.success(t('keys:plaintextCopied'))
      return
    }
    // Last resort works everywhere: leave the key selected for Ctrl/⌘+C.
    selectKey()
    toast.error(t('keys:clipboardDenied'))
  }

  return (
    <Dialog open={!!value} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t(value?.titleKey || 'keys:key')}
            {value?.name ? ` · ${value.name}` : ''}
          </DialogTitle>
        </DialogHeader>
        <p className='text-xs text-muted-foreground'>
          {value?.id ? (
            <span className='font-mono'>{value.id}</span>
          ) : (
            t('keys:plaintextOnlyHere')
          )}
        </p>
        <textarea
          ref={fieldRef}
          readOnly
          rows={2}
          aria-label={t('keys:plaintextKey')}
          spellCheck={false}
          value={plain}
          onFocus={(e) => e.currentTarget.select()}
          className='w-full resize-none rounded-md border bg-muted/40 p-3 font-mono text-sm break-all outline-none focus-visible:ring-2 focus-visible:ring-ring'
        />
        <p className='text-sm text-destructive'>{t('keys:revealHelp')}</p>
        <DialogFooter>
          <Button variant='outline' onClick={onClose}>
            {t('keys:close')}
          </Button>
          <Button onClick={() => void copy()}>{t('keys:copy')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
