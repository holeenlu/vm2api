// Test-only reconstruction of contracts already stored before global pricing.
// Production signup/editing must never call this fixture or write these prices.
import crypto from 'node:crypto'
const fields=['binance_id','default_price_cny_per_usd','group_prices','fx_cny_per_usdt','default_multiplier','contract_version']
const split=body=>{const account={...body},pricing={};for(const key of fields){if(Object.hasOwn(account,key))pricing[key]=account[key];delete account[key]}return {account,pricing}}
export function seedLegacyContract(platform,vendor,pricing={}){
 const row=typeof vendor==='string'?platform.getVendor(vendor):vendor
 const id='legacy_contract_'+crypto.randomUUID(),now=new Date().toISOString()
 const version=pricing.contract_version||platform.db.prepare('SELECT COALESCE(MAX(version),0)+1 n FROM vendor_contracts WHERE payee_vendor_id=? AND payer_vendor_id IS ?').get(row.id,row.parent_id||null).n
 platform.db.prepare(`INSERT INTO vendor_contracts(id,leg,payer_vendor_id,payee_vendor_id,version,effective_at,price_cny_per_usd,fx_cny_per_usdt,multiplier,group_prices_json,status,created_by,created_at)
 VALUES (?,?,?,?,?,?,?,?,?,?,'active','sa',?)`).run(id,row.tier===1?'platform_to_l1':'l1_to_l2',row.parent_id||null,row.id,version,pricing.effective_at||now,pricing.default_price_cny_per_usd??1.6,pricing.fx_cny_per_usdt??6.7,pricing.default_multiplier??1,JSON.stringify(pricing.group_prices||{}),now)
 return platform.db.prepare('SELECT * FROM vendor_contracts WHERE id=?').get(id)
}
export function createLegacyVendor(platform,args){const {account,pricing}=split(args.body);const row=platform.createRoot({...args,body:account});seedLegacyContract(platform,row,pricing);return row}
export function createLegacyChild(platform,identity,body){const {account,pricing}=split(body);const row=platform.createChild(identity,account);seedLegacyContract(platform,row,pricing);return row}
