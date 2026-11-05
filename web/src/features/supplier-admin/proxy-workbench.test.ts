import { describe, expect, it } from 'vitest'
import { proxyEditPayload } from './proxy-workbench-model'

describe('supplier proxy edit payload', () => {
  it('omits a blank endpoint so editing the name keeps the current proxy', () => {
    expect(proxyEditPayload('proxy-a', '   ')).toEqual({ name: 'proxy-a' })
  })

  it('sends a formatted endpoint when the address is changed', () => {
    expect(proxyEditPayload('proxy-a', ' socks5://host:1080 ')).toEqual({
      name: 'proxy-a',
      endpoint: 'socks5://host:1080',
    })
  })
})
