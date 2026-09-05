import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPaymentAdapter, createFileIntentStore } from './kayjay-payments.mjs';

// Provider transport doubles exercise contracts and failure handling, not live sandbox proof.
const cb = { destinationAddress:'0x'+'1'.repeat(40),destinationNetwork:'base',partnerUserRef:'sandbox-owner',purchaseCurrency:'USDC',paymentAmount:'10.00' };
const cbResponse = { order:{orderId:'11111111-1111-1111-1111-111111111111',partnerUserRef:'sandbox-owner',status:'ONRAMP_ORDER_STATUS_CREATED'},paymentLink:{url:'https://pay.coinbase.com/v2/api-onramp/apple-pay?sessionToken=example'} };
const response = data => ({ok:true,status:200,json:async()=>data});
function memoryStore() { const m = new Map(); return { get:async k=>m.get(k),insertIfAbsent:async(k,v)=>{if(m.has(k))return false;m.set(k,v);return true;},put:async(k,v)=>m.set(k,v) }; }
function setup(send,extra={}) { return createPaymentAdapter({store:memoryStore(),signJwt:async()=> 'secret',send,...extra}); }

test('Coinbase quote uses exact fixed endpoint, sandbox reference, quote flag, no redirects', async()=>{
  let call; const api=setup(async(...args)=>{call=args;return response(cbResponse);});
  await api.coinbaseQuote(cb);
  assert.equal(call[0],'https://api.cdp.coinbase.com/platform/v2/onramp/orders');
  assert.equal(call[1].redirect,'error');
  assert.equal(JSON.parse(call[1].body).isQuote,true);
  await assert.rejects(api.coinbaseQuote({...cb,partnerUserRef:'owner'}),{code:'sandbox_required'});
});
test('sandbox start durable replay does not submit again, rejects changed details',async()=>{
  let calls=0; const api=setup(async()=>{calls++;return response(cbResponse);});
  const first=await api.coinbaseSandboxStart(cb,'intent1');
  assert.match(first.paymentUrl,/useApplePaySandbox=true/);
  const duplicate=await api.coinbaseSandboxStart(cb,'intent1');
  assert.equal(duplicate.duplicate,true);assert.equal(calls,1);
  await assert.rejects(api.coinbaseSandboxStart({...cb,paymentAmount:'11.00'},'intent1'),{code:'intent_conflict'});
});
test('simultaneous submissions issue exactly one provider request',async()=>{
  let calls=0;const api=setup(async()=>{calls++;return response(cbResponse);});
  const outcomes=await Promise.allSettled([api.coinbaseSandboxStart(cb,'same'),api.coinbaseSandboxStart(cb,'same')]);
  assert.equal(calls,1);assert.ok(outcomes.some(x=>x.status==='fulfilled'));
});
test('timeout becomes unknown and cannot blindly retry, even after adapter restart',async()=>{
  const store=memoryStore();let calls=0;
  const api=setup(async()=>{calls++;return new Promise(()=>{});},{store,timeoutMs:10});
  await assert.rejects(api.coinbaseSandboxStart(cb,'timed'),{code:'provider_timeout'});
  const restarted=setup(async()=>{calls++;return response(cbResponse);},{store});
  await assert.rejects(restarted.coinbaseSandboxStart(cb,'timed'),{code:'outcome_unknown'});
  assert.equal((await restarted.reconcileIntent('timed')).retryAllowed,false);assert.equal(calls,1);
});
test('provider secret/error text is never exposed and failed HTTP-200 is rejected',async()=>{
  const api=setup(async()=>{throw new Error('private-user private-integration');});
  await assert.rejects(api.coinbaseQuote(cb),e=>e.code==='provider_unavailable'&&!e.message.includes('private'));
  const bad=setup(async()=>response({errorType:'auth',errorMessage:'private-user'}));
  await assert.rejects(bad.coinbaseQuote(cb),e=>e.code==='provider_invalid_response'&&!e.message.includes('private'));
});
test('payment URL must be official and cannot redirect credentials',async()=>{
  const api=setup(async()=>response({...cbResponse,paymentLink:{url:'https://attacker.example/pay'}}));
  await assert.rejects(api.coinbaseSandboxStart(cb,'evil'),{code:'provider_invalid_response'});
});
test('file intent store persists replay across processes/store instances',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'kayjay-payment-test-'));
  try {
    const path=join(directory,'payments.json');const a=createFileIntentStore(path);
    assert.equal(await a.insertIfAbsent('record',{state:'pending'}),true);
    const b=createFileIntentStore(path);assert.equal(await b.insertIfAbsent('record',{state:'new'}),false);
    assert.equal((await b.get('record')).state,'pending');
    await b.put('record',{state:'unknown'});assert.equal((await a.get('record')).state,'unknown');
  } finally {await rm(directory,{recursive:true,force:true});}
});
test('missing authorization fails clearly without sending',async()=>{
  let calls=0;const api=createPaymentAdapter({store:memoryStore(),send:async()=>{calls++;}});
  await assert.rejects(api.coinbaseQuote(cb),{code:'coinbase_auth_required'});
  assert.equal(calls,0);
});
test('status refuses wrong provider IDs and refuses labeling live Coinbase orders sandbox',async()=>{
  const live=setup(async()=>response({...cbResponse,order:{...cbResponse.order,partnerUserRef:'real-owner'}}));
  await assert.rejects(live.coinbaseStatus(cbResponse.order.orderId),{code:'provider_invalid_response'});
});
test('stored successful intent reconciles with provider instead of treating creation as settlement',async()=>{
  let calls=0;const api=setup(async()=>{calls++;return response(cbResponse);});
  await api.coinbaseSandboxStart(cb,'reconcile');
  const status=await api.reconcileIntent('reconcile');
  assert.equal(status.state,'reconciled');assert.equal(status.retryAllowed,false);
  assert.equal(status.order.status,'ONRAMP_ORDER_STATUS_CREATED');assert.equal(calls,2);
});
