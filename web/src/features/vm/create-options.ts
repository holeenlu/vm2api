import { t as tVm } from '@/i18n'
import { localizedOption } from './localized-option'

export const KERNELS = [
  {
    id: 'ubuntu-24.04',
    name: 'Ubuntu 24.04',
    base: 'kin-os/ubuntu:24.04',
    get size() {
      return tVm('vm:createOptions.standardMachine')
    },
    feats: ['LTS', 'apt', 'cli-hop wrap/crag', 'host-net'],
  },
  {
    id: 'debian-12',
    name: 'Debian 12',
    base: 'kin-os/debian:12',
    get size() {
      return tVm('vm:createOptions.standardMachine')
    },
    feats: ['glibc', 'apt', 'cli-hop wrap/crag', 'host-net'],
  },
  {
    id: 'archlinux',
    name: 'Arch Linux',
    base: 'kin-os/arch:latest',
    get size() {
      return tVm('vm:createOptions.standardMachine')
    },
    feats: ['rolling', 'pacman', 'cli-hop wrap/crag', 'host-net'],
  },
  {
    id: 'fedora-41',
    name: 'Fedora 41',
    base: 'kin-os/fedora:41',
    get size() {
      return tVm('vm:createOptions.standardMachine')
    },
    feats: ['dnf', 'glibc', 'cli-hop wrap/crag', 'host-net'],
  },
]

export type KernelProfile = {
  id: string
  name: string
  base: string
  size: string
  feats: string[]
}

export function kernelProfile(id?: string | null): KernelProfile | null {
  const k = String(id || '').trim()
  const known = KERNELS.find((x) => x.id === k)
  if (known) return known
  if (!k) return null
  return {
    id: k,
    name: k,
    base: '',
    size: '',
    feats: [tVm('vm:createOptions.customKernel')],
  }
}

/**
 * 「自动选区」的哨兵值。不能直接用空串：Radix `Select` 把 `value === ''` 当作
 * 「未选中」并渲染 placeholder，空串选项永远无法在 trigger 上显示出文案。
 * 提交时由调用方映射回 `undefined`。
 */
export const VM_REGION_AUTO = 'auto'

/** 创建槽位「环境」区的区域标签。只是写进槽位的地区标签，不影响出口。 */
export const VM_REGIONS: [string, string][] = [
  localizedOption(VM_REGION_AUTO, 'vm:createOptions.automatic'),
  localizedOption('us-west', 'vm:createOptions.uSWest'),
  localizedOption('us-central', 'vm:createOptions.uSCentral'),
  localizedOption('us-east', 'vm:createOptions.uSEast'),
  localizedOption('eu-west', 'vm:createOptions.europe'),
  localizedOption('ap-east', 'vm:createOptions.asiaPacificEast'),
  localizedOption('ap-southeast', 'vm:createOptions.asiaPacificSoutheast'),
]

/**
 * 「自定义」的哨兵值，与 `VM_REGION_AUTO` 同理：Radix `Select` 不接受空串选项。
 * 选中它时由调用方渲染输入框，提交的是输入框里的 IANA 名称。
 * 不能写成某个真实时区，否则自定义输入被清空时会静默提交这个时区。
 */
export const VM_TIMEZONE_CUSTOM = '__custom__'

/**
 * 环境时区预设。后端只校验 IANA 可解析（`validTimezone()`），不限美国区，
 * 所以这里是覆盖常见出口地区的快捷入口，真正的兜底是「自定义」。
 */
export const VM_TIMEZONES: [string, string][] = [
  localizedOption('America/Los_Angeles', 'vm:createOptions.losAngelesPT'),
  localizedOption('America/Denver', 'vm:createOptions.denverMT'),
  localizedOption('America/Chicago', 'vm:createOptions.chicagoCT'),
  localizedOption('America/New_York', 'vm:createOptions.newYorkET'),
  localizedOption('America/Sao_Paulo', 'vm:createOptions.sOPauloBRT'),
  localizedOption('Europe/London', 'vm:createOptions.londonGMTBST'),
  localizedOption('Europe/Paris', 'vm:createOptions.parisCET'),
  localizedOption('Europe/Berlin', 'vm:createOptions.berlinCET'),
  localizedOption('Europe/Moscow', 'vm:createOptions.moscowMSK'),
  localizedOption('Asia/Dubai', 'vm:createOptions.dubaiGST'),
  localizedOption('Asia/Kolkata', 'vm:createOptions.kolkataIST'),
  localizedOption('Asia/Bangkok', 'vm:createOptions.bangkokICT'),
  localizedOption('Asia/Shanghai', 'vm:createOptions.shanghaiCST'),
  localizedOption('Asia/Hong_Kong', 'vm:createOptions.hongKongHKT'),
  localizedOption('Asia/Taipei', 'vm:createOptions.taipeiCST'),
  localizedOption('Asia/Singapore', 'vm:createOptions.singaporeSGT'),
  localizedOption('Asia/Seoul', 'vm:createOptions.seoulKST'),
  localizedOption('Asia/Tokyo', 'vm:createOptions.tokyoJST'),
  localizedOption('Australia/Sydney', 'vm:createOptions.sydneyAEST'),
  ['UTC', 'UTC'],
  localizedOption(VM_TIMEZONE_CUSTOM, 'vm:createOptions.custom'),
]

/** 预设里是否已有这个时区（决定下拉该选预设项还是「自定义」）。 */
export function isPresetTimezone(value: string): boolean {
  return VM_TIMEZONES.some(([id]) => id === value && id !== VM_TIMEZONE_CUSTOM)
}

export const VM_LOCALES: [string, string][] = [
  ['en_US.UTF-8', 'English'],
  ['zh_CN.UTF-8', '中文'],
  ['zh_TW.UTF-8', '繁體中文'],
  ['ja_JP.UTF-8', '日本語'],
  ['C.UTF-8', 'C'],
]

/** 创建槽位「之后」的 5 档，决定 start / auto_allocate_proxy / activate 三个布尔。 */
export const VM_CREATE_AFTER: [string, string][] = [
  localizedOption('idle', 'vm:createOptions.createOnly'),
  localizedOption('start', 'vm:createOptions.start'),
  localizedOption('proxy', 'vm:createOptions.startAssignEgress'),
  localizedOption('active', 'vm:createOptions.startActivate'),
  localizedOption('full', 'vm:createOptions.startAssignEgressActivate'),
]
