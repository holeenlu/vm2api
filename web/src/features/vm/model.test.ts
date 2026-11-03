import { describe, expect, it } from 'vitest'
import {
  vmDisplayName,
  vmIsCodex,
  vmIsSchedulable,
  vmRuntimeKind,
} from './model'

describe('vm feature model', () => {
  it('normalizes display/runtime/scheduling facts', () => {
    const vm = {
      id: 'custom-slot',
      name: 'VM One',
      runtime_type: 'kvm',
      family: 'codex',
      schedulable: false,
    } as any
    expect(vmDisplayName(vm)).toBe('VM One')
    expect(vmRuntimeKind(vm)).toBe('kvm')
    expect(vmIsCodex(vm)).toBe(true)
    expect(vmIsSchedulable(vm)).toBe(false)
  })
})
