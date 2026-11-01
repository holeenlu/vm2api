import { expect, test } from 'vitest'
import { panelQueryKeys } from './query-keys'

test('panel query keys keep existing cache shapes', () => {
  expect(panelQueryKeys.apiEndpoints()).toEqual(['panel', 'api-endpoints'])
  expect(panelQueryKeys.apiKeys('mine')).toEqual(['panel', 'api-keys', 'mine'])
  expect(panelQueryKeys.apiKeyStats('k1')).toEqual(['panel', 'api-keys', 'k1', 'stats'])
  expect(panelQueryKeys.dashboard()).toEqual(['panel', 'dashboard'])
  expect(panelQueryKeys.usage()).toEqual(['panel', 'usage'])
})
