import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { VendorPlatform } from '../../src/lib/vendor/vendor-platform.mjs'
import { createGlobalPricing, listGlobalPricing, quoteUsagePricing, pricingEffectiveAt } from '../../src/lib/vendor/vendor-pricing.mjs'
import { settlementPreview, createSettlement, settlementAction } from '../../src/lib/vendor/vendor-admin.mjs'
import { previewDownstreamSettlements,createDownstreamSettlement,mutateDownstreamSettlement,supplierBilling } from '../../src/lib/vendor/vendor-settlements.mjs'
import { recordVendorUsage } from '../../src/lib/vendor/vendor-usage.mjs'
const actor={system_admin:true,user_id:'sa'}
const period={start_date:'2026-10-01T00:00:00.000Z',end_date:'2026-10-03T00:00:00.000Z'}
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'global-pricing-')),db=createDatabase({dataDir:dir})
 t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true})})
 db.prepare("UPDATE groups SET platform='mixed' WHERE id=1").run()
 const service=new VendorPlatform(db,{vmProvisioner:({resourceId})=>({id:'runtime-'+resourceId})})
 const create=name=>service.createRoot({actorUserId:'sa',body:{username:name,password:'test-password',capabilities:['vendor.create_child','vendor.resource.manage','vendor.vm.create','vendor.usage.read','vendor.settlement.read','vendor.settlement.pay']}})
 const parent=create('pricing-parent'),peer=create('pricing-peer')
 const identity={user_id:db.prepare("SELECT id FROM users WHERE username='pricing-parent'").get().id,vendor:parent}
 const child=service.createChild(identity,{username:'pricing-child',password:'test-password'})
 const childIdentity={user_id:db.prepare("SELECT id FROM users WHERE username='pricing-child'").get().id,vendor:child}
 const pair=service.createAccount(childIdentity,{platform:'openai',name:'global-price-account'})
 const add=(id,at,cost=10)=>{db.prepare("INSERT INTO usage_logs(id,request_id,vm_id,created_at,status,model,total_cost,input_tokens,output_tokens) VALUES (?,?,?,?,200,'gpt-5',?,100,20)").run(id,id,pair.vm.config.runtime_vm_id,at,cost);recordVendorUsage(db,db.prepare('SELECT * FROM usage_logs WHERE id=?').get(id))}
 const price=(key,date,openai,claude,fx)=>createGlobalPricing(service,actor,{idempotency_key:key,effective_date:date,openai_price:openai,claude_price:claude,exchange_rate:fx})
 return {db,service,parent,peer,identity,child,childIdentity,pair,add,price}
}
test('global prices use Shanghai midnight, apply to every supplier, and preserve scheduled date precedence',t=>{
 const f=fixture(t)
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM vendor_contracts').get().n,0)
 const first=f.price('price-first','2026-10-01',2,1.5,5)
 const second=f.price('price-next','2026-10-02',4,3,8)
 assert.equal(second.effective_at,'2026-10-01T16:00:00.000Z')
 const rows=[{id:'before',platform:'openai',created_at:'2026-10-01T15:59:59.999Z',total_cost:10},{id:'boundary',platform:'openai',created_at:second.effective_at,total_cost:10}]
 for(const vendor of [f.parent,f.peer]){
  const q=quoteUsagePricing(f.service,vendor.id,null,rows)
  assert.equal(q.amount_usdt,9)
  assert.deepEqual(q.lines.map(r=>r.amount_usdt),['4.000000','5.000000'])
  assert.equal(q.pricing_versions.length,2)
 }
 const later=f.price('same-day-change','2026-10-01',3,2,5)
 assert.equal(listGlobalPricing(f.service,{now:Date.parse('2026-10-01T12:00:00Z')}).current.id,later.id)
 assert.equal(listGlobalPricing(f.service,{now:Date.parse('2026-10-02T12:00:00Z')}).current.id,second.id)
 assert.equal(listGlobalPricing(f.service).items.find(r=>r.id===first.id).state,'superseded')
})
test('settings require SA, reject supplier-specific fields, and append idempotently without rewriting old versions',t=>{
 const f=fixture(t),body={idempotency_key:'fixed-price-key',effective_date:'2026-10-01',openai_price:2,claude_price:1,exchange_rate:5}
 assert.throws(()=>createGlobalPricing(f.service,f.identity,body),e=>e.status===403)
 assert.throws(()=>createGlobalPricing(f.service,actor,{...body,vendor_id:f.peer.id}),e=>e.code==='invalid_pricing_fields')
 assert.throws(()=>pricingEffectiveAt('2026-02-30'),e=>e.code==='invalid_effective_date')
 const a=createGlobalPricing(f.service,actor,body),b=createGlobalPricing(f.service,actor,body)
 assert.equal(a.id,b.id)
 assert.throws(()=>createGlobalPricing(f.service,actor,{...body,openai_price:3}),e=>e.code==='idempotency_conflict')
 assert.throws(()=>f.service.createChild(f.identity,{username:'bad-price-child',password:'test-password',fx_cny_per_usdt:6.7}),e=>e.code==='pricing_settings_required')
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM vendor_contracts').get().n,1)
})
test('a new supplier has no implicit price before the first global effective date',t=>{
 const f=fixture(t)
 f.price('first-future-price','2026-10-02',2,1,5)
 assert.throws(()=>quoteUsagePricing(f.service,f.parent.id,null,[{id:'old',platform:'openai',created_at:'2026-10-01T15:59:59Z',total_cost:10}]),e=>e.code==='pricing_not_effective')
})
test('both payer edges use the same dated prices and ownership never comes from the shared global contract',t=>{
 const f=fixture(t);f.price('global-first','2026-10-01',2,1,5);f.price('global-second','2026-10-02',4,3,8)
 f.add('before','2026-10-01T15:00:00.000Z');f.add('after','2026-10-01T16:00:00.000Z')
 const upper=settlementPreview(f.service,f.parent.id,period)
 assert.equal(upper.amount_usdt,9)
 const upperBill=createSettlement(f.service,f.parent.id,{...period,preview_token:upper.preview_token},'sa')
 const quote=previewDownstreamSettlements(f.service,f.identity,{vendor_ids:[f.child.id],start_date:'2026-10-01',end_date:'2026-10-02',timezone:'Asia/Shanghai'}).items[0]
 assert.equal(quote.statement.total_usdt,'9.000000')
 const lower=createDownstreamSettlement(f.service,f.identity,{preview_token:quote.preview_token,idempotency_key:'lower-invoice-once'})
 assert.equal(lower.payer_vendor_id,f.parent.id)
 assert.equal(lower.payee_vendor_id,f.child.id)
 assert.equal(upperBill.payer_vendor_id,null)
 assert.equal(upperBill.payee_vendor_id,f.parent.id)
 assert.throws(()=>settlementAction(f.service,lower.id,'confirm',{},'sa'),e=>e.code==='settlement_payer_scope')
 mutateDownstreamSettlement(f.service,f.identity,lower.id,'confirm')
 assert.equal(supplierBilling(f.service,f.childIdentity).upstream[0].id,lower.id)
 const frozen=f.db.prepare('SELECT usage_snapshot_json FROM vendor_settlements WHERE id=?').get(lower.id).usage_snapshot_json
 f.price('retroactive-new','2026-10-01',20,10,5)
 assert.equal(f.db.prepare('SELECT usage_snapshot_json FROM vendor_settlements WHERE id=?').get(lower.id).usage_snapshot_json,frozen)
 assert.equal(createDownstreamSettlement(f.service,f.identity,{preview_token:quote.preview_token,idempotency_key:'lower-invoice-once'}).amount_usdt,9)
})
test('recorded supplier USD is stable across log repricing and pruning',t=>{
 const f=fixture(t);f.price('stable-fact-price','2026-10-01',2,1,5);f.add('fact','2026-10-01T10:00:00.000Z')
 f.db.prepare('UPDATE usage_logs SET total_cost=999').run()
 assert.equal(settlementPreview(f.service,f.parent.id,period).amount_usdt,4)
 f.db.prepare('DELETE FROM usage_logs').run()
 assert.equal(settlementPreview(f.service,f.parent.id,period).amount_usdt,4)
})
