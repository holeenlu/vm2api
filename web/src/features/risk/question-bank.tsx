import { useState } from 'react'
import type { PolicyQuestion } from '@/types/panel-routing'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'

const MAX_QUESTIONS = 24

function nextId(label: string, rows: PolicyQuestion[]) {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  let id = /^[a-z]/.test(base) ? base : `q${Date.now().toString(36)}`
  const used = new Set(rows.map((row) => row.id))
  let n = 2
  while (used.has(id) || id === 'custom') {
    id = `${(base || 'q').slice(0, 28)}-${n++}`
  }
  return id.slice(0, 32)
}

/**
 * Questions the decision model answers in one call. Edits stay in the
 * parent's draft; nothing is saved until the stage's save bar.
 */
export function QuestionBank({
  rows,
  onChange,
}: {
  rows: PolicyQuestion[]
  onChange: (rows: PolicyQuestion[]) => void
}) {
  const { t: translate } = useTranslation('risk')

  const [editing, setEditing] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const [summary, setSummary] = useState('')
  const [instructions, setInstructions] = useState('')

  const patch = (id: string, next: Partial<PolicyQuestion>) =>
    onChange(rows.map((row) => (row.id === id ? { ...row, ...next } : row)))

  const add = () => {
    const name = label.trim()
    const text = instructions.trim()
    if (!name || !text) {
      toast.error(translate('risk:questionNameRequired'))
      return
    }
    if (rows.length >= MAX_QUESTIONS) {
      toast.error(translate('risk:maxQuestions', { count: MAX_QUESTIONS }))
      return
    }
    onChange([
      ...rows,
      {
        id: nextId(name, rows),
        label: name,
        summary: summary.trim(),
        instructions: text,
        enabled: true,
        builtin: false,
      },
    ])
    setLabel('')
    setSummary('')
    setInstructions('')
  }

  return (
    <div className='space-y-4'>
      <ul className='divide-y overflow-hidden rounded-xl border'>
        {rows.map((row) => (
          <li key={row.id} className='space-y-2 px-4 py-3'>
            <div className='flex items-start justify-between gap-3'>
              <div className='min-w-0'>
                <div className='flex flex-wrap items-center gap-2'>
                  <p className='text-sm font-medium'>{row.label}</p>
                  {row.builtin ? (
                    <Badge variant='outline' className='font-normal'>
                      {translate('risk:builtIn')}
                    </Badge>
                  ) : null}
                  <span className='font-mono text-xs text-muted-foreground'>
                    {row.id}
                  </span>
                </div>
                {row.summary ? (
                  <p className='text-xs text-muted-foreground'>{row.summary}</p>
                ) : null}
              </div>
              <div className='flex shrink-0 items-center gap-1'>
                <Switch
                  checked={row.enabled}
                  aria-label={translate('risk:enableQuestion', {
                    p0: row.label,
                  })}
                  onCheckedChange={(on) => patch(row.id, { enabled: on })}
                />
                <Button
                  size='sm'
                  variant='ghost'
                  className='cursor-pointer'
                  onClick={() => setEditing(editing === row.id ? null : row.id)}
                >
                  {editing === row.id
                    ? translate('risk:collapse')
                    : translate('risk:edit')}
                </Button>
                <Button
                  size='sm'
                  variant='ghost'
                  className='cursor-pointer text-destructive'
                  onClick={() => {
                    onChange(rows.filter((item) => item.id !== row.id))
                    if (editing === row.id) setEditing(null)
                  }}
                >
                  {translate('risk:delete')}
                </Button>
              </div>
            </div>
            {editing === row.id ? (
              <div className='grid gap-3'>
                <div className='grid gap-3 sm:grid-cols-2'>
                  <div className='space-y-1.5'>
                    <Label htmlFor={`q-label-${row.id}`}>
                      {translate('risk:name')}
                    </Label>
                    <Input
                      id={`q-label-${row.id}`}
                      value={row.label}
                      onChange={(e) => patch(row.id, { label: e.target.value })}
                    />
                  </div>
                  <div className='space-y-1.5'>
                    <Label htmlFor={`q-summary-${row.id}`}>
                      {translate('risk:description')}
                    </Label>
                    <Input
                      id={`q-summary-${row.id}`}
                      value={row.summary}
                      onChange={(e) =>
                        patch(row.id, { summary: e.target.value })
                      }
                    />
                  </div>
                </div>
                <div className='space-y-1.5'>
                  <Label htmlFor={`q-text-${row.id}`}>
                    {translate('risk:question')}
                  </Label>
                  <Textarea
                    id={`q-text-${row.id}`}
                    rows={3}
                    value={row.instructions}
                    onChange={(e) =>
                      patch(row.id, { instructions: e.target.value })
                    }
                  />
                </div>
              </div>
            ) : (
              <p className='max-w-[75ch] text-sm leading-6 text-muted-foreground'>
                {row.instructions}
              </p>
            )}
          </li>
        ))}
        {rows.length ? null : (
          <li className='px-4 py-6 text-sm text-muted-foreground'>
            {translate('risk:noQuestions')}
          </li>
        )}
      </ul>

      <div className='space-y-3 rounded-xl border border-dashed p-4'>
        <div className='grid gap-3 sm:grid-cols-2'>
          <div className='space-y-1.5'>
            <Label htmlFor='new-question-label'>
              {translate('risk:newQuestionName')}
            </Label>
            <Input
              id='new-question-label'
              value={label}
              placeholder={translate('risk:questionNameExample')}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <div className='space-y-1.5'>
            <Label htmlFor='new-question-summary'>
              {translate('risk:description')}
            </Label>
            <Input
              id='new-question-summary'
              value={summary}
              placeholder={translate('risk:questionDescriptionPlaceholder')}
              onChange={(e) => setSummary(e.target.value)}
            />
          </div>
        </div>
        <div className='space-y-1.5'>
          <Label htmlFor='new-question-text'>
            {translate('risk:question')}
          </Label>
          <Textarea
            id='new-question-text'
            rows={3}
            value={instructions}
            placeholder={translate('risk:questionPlaceholder')}
            onChange={(e) => setInstructions(e.target.value)}
          />
        </div>
        <Button
          type='button'
          variant='outline'
          className='cursor-pointer'
          onClick={add}
        >
          {translate('risk:addQuestion')}
        </Button>
      </div>
    </div>
  )
}
