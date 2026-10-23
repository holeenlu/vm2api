import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { FormField } from '@/components/form-field'
import { PageHeader } from '@/components/page-header'

type Profile = {
  username: string
  display_name: string
  email: string
  role: string
}
export function ProfilePage() {
  const { t } = useTranslation('profile')
  const qc = useQueryClient()
  const profile = useQuery({
    queryKey: ['panel', 'profile'],
    queryFn: () => api<Profile>('/api/panel/me/profile'),
  })
  const [draft, setDraft] = useState<Partial<Profile>>({})
  const [password, setPassword] = useState({
    current_password: '',
    new_password: '',
    confirm: '',
  })
  const [busy, setBusy] = useState(false)
  async function save(kind: 'profile' | 'password') {
    if (kind === 'password' && password.new_password !== password.confirm)
      return toast.error(t('passwordMismatch'))
    setBusy(true)
    try {
      await api(`/api/panel/me/${kind}`, {
        method: kind === 'profile' ? 'PATCH' : 'POST',
        body: JSON.stringify(
          kind === 'profile'
            ? {
                display_name:
                  draft.display_name ?? profile.data?.display_name ?? '',
                email: draft.email ?? profile.data?.email ?? '',
              }
            : {
                current_password: password.current_password,
                new_password: password.new_password,
              }
        ),
      })
      if (kind === 'profile') setDraft({})
      else setPassword({ current_password: '', new_password: '', confirm: '' })
      await qc.invalidateQueries({ queryKey: ['panel', 'profile'] })
      await qc.invalidateQueries({ queryKey: ['panel', 'me'] })
      toast.success(t(kind === 'profile' ? 'saved' : 'passwordChanged'))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <PageHeader title={t('title')} description={t('description')}>
      {profile.error && <p role='alert'>{profile.error.message}</p>}
      {profile.data && (
        <div className='grid max-w-4xl gap-6 lg:grid-cols-2'>
          <form
            className='space-y-4 rounded-xl border p-5'
            onSubmit={(e) => {
              e.preventDefault()
              void save('profile')
            }}
          >
            <h3 className='font-semibold'>{t('title')}</h3>
            <FormField>
              {t('username')}
              <Input value={profile.data.username} disabled />
            </FormField>
            <FormField>
              {t('displayName')}
              <Input
                maxLength={80}
                value={draft.display_name ?? profile.data.display_name}
                onChange={(e) =>
                  setDraft({ ...draft, display_name: e.target.value })
                }
              />
            </FormField>
            <FormField>
              {t('email')}
              <Input
                type='email'
                maxLength={254}
                autoComplete='email'
                value={draft.email ?? profile.data.email}
                onChange={(e) => setDraft({ ...draft, email: e.target.value })}
              />
            </FormField>
            <p className='text-xs text-muted-foreground'>{t('identityHelp')}</p>
            <p className='text-xs text-muted-foreground'>{t('emailHelp')}</p>
            <Button disabled={busy || !Object.keys(draft).length}>
              {t('save')}
            </Button>
          </form>
          <form
            id='password'
            className='space-y-4 rounded-xl border p-5'
            onSubmit={(e) => {
              e.preventDefault()
              void save('password')
            }}
          >
            <h3 className='font-semibold'>{t('changePassword')}</h3>
            {(
              [
                ['current_password', 'currentPassword'],
                ['new_password', 'newPassword'],
                ['confirm', 'confirmPassword'],
              ] as const
            ).map(([key, label]) => (
              <FormField key={key}>
                {t(label)}
                <Input
                  type='password'
                  required
                  minLength={key === 'current_password' ? 1 : 8}
                  maxLength={128}
                  autoComplete={
                    key === 'current_password'
                      ? 'current-password'
                      : 'new-password'
                  }
                  value={password[key]}
                  onChange={(e) =>
                    setPassword({ ...password, [key]: e.target.value })
                  }
                />
              </FormField>
            ))}
            <Button disabled={busy}>{t('changePassword')}</Button>
          </form>
        </div>
      )}
    </PageHeader>
  )
}
