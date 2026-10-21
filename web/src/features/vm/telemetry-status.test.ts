import { i18n } from '@/i18n'
import { beforeEach, describe, expect, it } from 'vitest'
import { telemetryStatusLabel } from './telemetry-status'

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN')
})

describe('telemetry status distinguishes configuration from process observations', () => {
  it('does not report missing legacy status as disabled or running', () => {
    expect(telemetryStatusLabel(undefined)).toBe('状态未知')
    expect(telemetryStatusLabel(null)).toBe('状态未知')
    expect(telemetryStatusLabel({ enabled: null, running: true })).toBe(
      '状态未知'
    )
    expect(telemetryStatusLabel({ enabled: true })).toBe(
      '已开启 · 运行状态未知'
    )
  })
  it('reports actual running and stopped telemetry separately', () => {
    expect(telemetryStatusLabel({ enabled: true, running: true })).toBe(
      '运行中'
    )
    expect(telemetryStatusLabel({ enabled: true, running: false })).toBe(
      '已开启 · 进程未运行'
    )
    expect(telemetryStatusLabel({ enabled: true, running: null })).toBe(
      '已开启 · 运行状态未知'
    )
  })
  it('does not mistake the idle config watcher for enabled telemetry', () => {
    expect(telemetryStatusLabel({ enabled: false, running: true })).toBe(
      '未启用'
    )
  })
})
