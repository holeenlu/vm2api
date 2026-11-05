import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'
import {
  gatewayProxyProjection,
  globalRequestLocation,
  normalizeRequestLocation,
  proxyRequestLocation,
  readRequestLocationSetting,
} from '../../src/lib/gateway-worker/request-location.mjs'

test('request locations follow the CPR validation rules', () => {
  assert.deepEqual(
    normalizeRequestLocation({ country: 'JP', region: ' Tokyo ', city: 'Chiyoda', timezone: 'Asia/Tokyo' }),
    {
      country: 'JP',
      region: 'Tokyo',
      city: 'Chiyoda',
      timezone: 'Asia/Tokyo',
    },
  )
  for (const bad of [
    { country: 'jp', region: 'Tokyo', city: 'Chiyoda', timezone: 'Asia/Tokyo' },
    { country: 'JP', region: 'To\nkyo', city: 'Chiyoda', timezone: 'Asia/Tokyo' },
    { country: 'JP', region: 'x'.repeat(129), city: 'Chiyoda', timezone: 'Asia/Tokyo' },
    { country: 'JP', region: 'Tokyo', city: '', timezone: 'Asia/Tokyo' },
    { country: 'JP', region: 'Tokyo', city: 'Chiyoda', timezone: 'Mars/Base' },
    { country: 'JP', region: 'Tokyo', city: 'Chiyoda', timezone: 'Asia/Tokyo', extra: 1 },
  ]) {
    assert.throws(() => normalizeRequestLocation(bad), { code: 'invalid_request_location' }, JSON.stringify(bad))
  }
})

test('proxy locations: manual fields, detected exits and IPv4/IPv6 conflicts', () => {
  const geo = { geo_country_code: 'DE', geo_region: 'Hesse', geo_city: 'Frankfurt', geo_timezone: 'Europe/Berlin' }
  assert.equal(proxyRequestLocation({ ...geo }), null, 'inherit never overrides')
  assert.deepEqual(proxyRequestLocation({ ...geo, request_location_mode: 'auto' }), {
    country: 'DE',
    region: 'Hesse',
    city: 'Frankfurt',
    timezone: 'Europe/Berlin',
  })
  const v6 = {
    geo_v6_country_code: 'NL',
    geo_v6_region: 'North Holland',
    geo_v6_city: 'Amsterdam',
    geo_v6_timezone: 'Europe/Amsterdam',
  }
  assert.equal(
    proxyRequestLocation({ ...geo, ...v6, request_location_mode: 'auto' }),
    null,
    'conflicting exits withdraw the override',
  )
  assert.equal(proxyRequestLocation({ ...v6, request_location_mode: 'auto' }).timezone, 'Europe/Amsterdam')
  assert.equal(
    proxyRequestLocation({ geo_country_code: 'DE', request_location_mode: 'auto' }),
    null,
    'incomplete detection is ignored',
  )
  assert.deepEqual(
    proxyRequestLocation({
      ...geo,
      request_location_mode: 'manual',
      location_country: 'US',
      location_region: 'Ohio',
      location_city: 'Piketon',
      location_timezone: 'America/New_York',
    }),
    { country: 'US', region: 'Ohio', city: 'Piketon', timezone: 'America/New_York' },
  )
})

test('global setting and Gateway projection carry the effective locations', () => {
  const db = createDatabase({ dbPath: ':memory:' })
  try {
    assert.equal(globalRequestLocation(db), null)
    assert.equal(readRequestLocationSetting(db).location.city, 'Piketon')
    new SettingsRepo(db).set('codex_request_location', {
      enabled: true,
      location: { country: 'SG', region: 'Singapore', city: 'Singapore', timezone: 'Asia/Singapore' },
    })
    assert.equal(globalRequestLocation(db).timezone, 'Asia/Singapore')
    db.prepare(
      "INSERT INTO proxies(id,protocol,host,port,enabled,max_websocket_connections,request_location_mode,geo_country_code,geo_region,geo_city,geo_timezone,created_at,updated_at) VALUES('px','socks5','1.2.3.4',1080,1,3,'auto','DE','Hesse','Frankfurt','Europe/Berlin','now','now')",
    ).run()
    assert.deepEqual(gatewayProxyProjection(db, { proxy_id: 'px' }), {
      proxy_max_websocket_connections: 3,
      request_location: { country: 'DE', region: 'Hesse', city: 'Frankfurt', timezone: 'Europe/Berlin' },
    })
    assert.deepEqual(gatewayProxyProjection(db, {}), { proxy_max_websocket_connections: 0, request_location: null })
  } finally {
    db.close()
  }
})

test('proxy pool edits store the request location mode and manual location', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-px-loc-'))
  const pool = new ProxyPool({ dataDir })
  pool.stopScheduler()
  pool.importLines('socks5://alice:s3cret@1.2.3.4:1080')
  const proxy = pool.state.proxies[0]
  assert.equal(pool.publicProxy(proxy).request_location_mode, 'inherit')
  assert.equal(pool.update(proxy.id, { request_location_mode: 'manual' }).error, 'request_location_required')
  const updated = pool.update(proxy.id, {
    request_location_mode: 'manual',
    location: { country: 'GB', region: 'England', city: 'London', timezone: 'Europe/London' },
  })
  assert.equal(updated.ok, true)
  assert.deepEqual(updated.proxy.effective_request_location, {
    country: 'GB',
    region: 'England',
    city: 'London',
    timezone: 'Europe/London',
  })
  assert.equal(pool.update(proxy.id, { request_location_mode: 'everywhere' }).error, 'invalid_request_location_mode')
  assert.equal(
    pool.update(proxy.id, { location: { country: 'GB', region: 'England', city: 'London', timezone: 'Nowhere' } })
      .error,
    'invalid_request_location',
  )
  assert.equal(pool.update(proxy.id, { port: 1081 }).ok, true)
  assert.equal(proxy.location_timezone, 'Europe/London', 'connection edits keep the location')
  assert.equal(pool.update(proxy.id, { request_location_mode: 'inherit' }).proxy.effective_request_location, null)
})
