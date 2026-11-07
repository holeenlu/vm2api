import { api } from '@/lib/api'
import { accountBase } from './accounts-model'

export type ExportResult = {
  file: { type: string; version: number; accounts: unknown[] }
  failed: { id: string; name: string; error: { message?: string } }[]
}

export type ImportResult = {
  imported: number
  items: {
    index: number
    name: string
    ok: boolean
    id?: string
    error?: { message?: string }
  }[]
}

/** 导出所选账号为 JSON 文件（含原生授权令牌）并触发下载。 */
export async function exportGatewayAccounts(ids: string[]) {
  const data = await api<ExportResult>(`${accountBase}/export`, {
    method: 'POST',
    body: JSON.stringify({ ids }),
  })
  if (data.file.accounts.length) {
    const blob = new Blob([JSON.stringify(data.file, null, 2)], {
      type: 'application/json',
    })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `gateway-accounts-${new Date().toISOString().slice(0, 10)}.json`
    link.click()
    URL.revokeObjectURL(link.href)
  }
  return data
}
