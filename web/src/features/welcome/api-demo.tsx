import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { CopyButton } from '@/components/copy-chip'

type Demo = {
  id: string
  label: string
  path: string
  auth: string
  body: string[]
  response: string[]
}

// Example payloads mirror the three entries documented on /guide/api.
const DEMOS: Demo[] = [
  {
    id: 'messages',
    label: 'Claude',
    path: '/v1/messages',
    auth: 'x-api-key: sk-vm-xxxx',
    body: [
      '"model": "claude-sonnet-5",',
      '"max_tokens": 1024,',
      '"messages": [{ "role": "user", "content": "hello" }]',
    ],
    response: [
      '{',
      '  "type": "message",',
      '  "content": [{ "type": "text", "text": "Hello!" }],',
      '  "usage": { "input_tokens": 8, "output_tokens": 5 }',
      '}',
    ],
  },
  {
    id: 'chat',
    label: 'Chat',
    path: '/v1/chat/completions',
    auth: 'Authorization: Bearer sk-vm-xxxx',
    body: [
      '"model": "gpt-5.4",',
      '"messages": [{ "role": "user", "content": "hello" }]',
    ],
    response: [
      '{',
      '  "object": "chat.completion",',
      '  "choices": [{ "message": { "content": "Hello!" } }]',
      '}',
    ],
  },
  {
    id: 'responses',
    label: 'Responses',
    path: '/v1/responses',
    auth: 'Authorization: Bearer sk-vm-xxxx',
    body: ['"model": "gpt-5.4",', '"input": "hello"'],
    response: [
      '{',
      '  "object": "response",',
      '  "output": [{ "type": "message", "content": [ … ] }]',
      '}',
    ],
  },
]

const STRING_RE = /"[^"]*"/g

/** Use the shared selection and primary colors for readable code in both themes. */
function Json({ line }: { line: string }) {
  useTranslation('welcome')

  const parts: React.ReactNode[] = []
  let cursor = 0
  for (const m of line.matchAll(STRING_RE)) {
    const start = m.index ?? 0
    if (start > cursor)
      parts.push(
        <span key={`p${start}`} className='text-muted-foreground'>
          {line.slice(cursor, start)}
        </span>
      )
    const isKey = line
      .slice(start + m[0].length)
      .trimStart()
      .startsWith(':')
    parts.push(
      <span
        key={`s${start}`}
        className={isKey ? 'text-select-fg' : 'text-primary'}
      >
        {m[0]}
      </span>
    )
    cursor = start + m[0].length
  }
  if (cursor < line.length)
    parts.push(
      <span key='tail' className='text-muted-foreground'>
        {line.slice(cursor)}
      </span>
    )
  return <span className='block'>{parts}</span>
}

/** Static request/response card: switching tabs is the only interaction. */
export function ApiDemo({ baseUrl }: { baseUrl: string }) {
  const { t } = useTranslation('welcome')

  const [active, setActive] = useState(DEMOS[0].id)
  const demo = DEMOS.find((item) => item.id === active) ?? DEMOS[0]
  const curl = [
    `curl -X POST "${baseUrl}${demo.path}" \\`,
    `  -H "${demo.auth}" \\`,
    '  -H "content-type: application/json" \\',
    "  -d '{",
    ...demo.body.map((l) => `    ${l}`),
    "  }'",
  ].join('\n')

  return (
    <Tabs
      value={active}
      onValueChange={setActive}
      className='mx-auto w-full max-w-2xl min-w-0 gap-0 overflow-hidden rounded-xl border bg-card shadow-sm'
    >
      <div className='flex flex-wrap items-center justify-between gap-2 border-b px-3 py-3 sm:px-4'>
        <TabsList aria-label={t('welcome:apiExample')}>
          {DEMOS.map((item) => (
            <TabsTrigger key={item.id} value={item.id} className='px-3 text-xs'>
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <CopyButton
          text={curl}
          label={t('welcome:copyCurl', { client: demo.label })}
          className='shrink-0'
        />
      </div>

      <TabsContent value={demo.id} className='min-w-0'>
        <div className='flex min-w-0 items-center gap-2 border-b px-4 py-3 sm:px-5'>
          <Badge variant='secondary' className='font-mono text-xs'>
            POST
          </Badge>
          <code className='min-w-0 font-mono text-xs break-all text-foreground'>
            {demo.path}
          </code>
        </div>

        <div className='px-4 py-4 sm:px-5'>
          <p className='mb-3 text-xs font-medium text-muted-foreground'>
            {t('welcome:request')}
          </p>
          <pre
            tabIndex={0}
            aria-label={t('welcome:request')}
            className='min-h-48 overflow-x-auto rounded-md font-mono text-xs leading-6 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
          >
            <code>
              {curl.split('\n').map((line, i) => (
                <Json key={i} line={line} />
              ))}
            </code>
          </pre>
        </div>

        <div className='border-t bg-muted/30 px-4 py-4 sm:px-5'>
          <div className='mb-3 flex items-center justify-between gap-2'>
            <p className='text-xs font-medium text-muted-foreground'>
              {t('welcome:response')}
            </p>
            <Badge
              variant='outline'
              className='border-primary/20 bg-accent font-mono text-xs text-accent-foreground uppercase'
            >
              200 ok
            </Badge>
          </div>
          <pre
            tabIndex={0}
            aria-label={t('welcome:response')}
            className='min-h-30 overflow-x-auto rounded-md font-mono text-xs leading-6 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
          >
            <code>
              {demo.response.map((line, i) => (
                <Json key={i} line={line} />
              ))}
            </code>
          </pre>
        </div>
      </TabsContent>

      <div className='flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t px-4 py-3 text-xs text-muted-foreground sm:px-5'>
        <span>{t('welcome:placeholderKey')}</span>
        <span className='font-mono uppercase'>stream · sse</span>
      </div>
    </Tabs>
  )
}
