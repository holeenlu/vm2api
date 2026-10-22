export type ProxyQualityReport = {
  proxy_id: string
  score: number
  grade: string
  checked_at: number
  exit_ip: string | null
  country: string | null
  base_latency_ms: number
  passed_count: number
  warn_count: number
  failed_count: number
  challenge_count: number
  items: {
    target: string
    status: 'pass' | 'warn' | 'fail' | 'challenge'
    http_status?: number
    latency_ms: number
    message: string
    cf_ray?: string | null
  }[]
}
