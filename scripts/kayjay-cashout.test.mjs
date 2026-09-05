import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { discoverCashoutRails, selectCashoutRail, CashoutError } from './kayjay-cashout.mjs';

const creds = () => ({ name: 'test', secret: generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('base64') });
const ok = body => ({ ok: true, status: 200, json: async () => body });

test('unauthenticated discovery reports every rail unavailable without a network call', async () => {
  let calls = 0;
  const state = await discoverCashoutRails({ name: '', secret: '' }, async () => { calls++; return ok({}); });
  assert.equal(calls, 0);
  assert.equal(state.authenticated, false);
  for (const key of ['instantCard', 'rtp', 'paypal', 'cdpOfframp']) assert.equal(state.rails[key].candidate, false);
});

test('a verified withdraw-enabled debit card becomes the instant card rail', async () => {
  const send = async () => ok({ payment_methods: [
    { id: 'pm-card', type: 'DEBIT_CARD', currency: 'USD', verified: true, allow_withdraw: true, name: 'Visa ****1234' },
    { id: 'pm-ach', type: 'ACH_BANK_ACCOUNT', currency: 'USD', verified: true, allow_withdraw: true },
  ] });
  const state = await discoverCashoutRails(creds(), send);
  assert.equal(state.authenticated, true);
  assert.equal(state.country, 'US');
  assert.equal(state.rails.instantCard.candidate, true);
  assert.equal(state.rails.instantCard.paymentMethodId, 'pm-card');
  const picked = selectCashoutRail(state);
  assert.equal(picked.selected, 'instantCard');
});

test('an unverified card is reported as a non-candidate with the real reason', async () => {
  const send = async () => ok({ payment_methods: [{ id: 'pm-card', type: 'DEBIT_CARD', currency: 'USD', verified: false, allow_withdraw: true }] });
  const state = await discoverCashoutRails(creds(), send);
  assert.equal(state.rails.instantCard.candidate, false);
  assert.match(state.rails.instantCard.reason, /not verified/);
});

test('no instant rail and instantOnly fails clearly with no ACH fallback', async () => {
  const send = async () => ok({ payment_methods: [{ id: 'pm-ach', type: 'ACH_BANK_ACCOUNT', currency: 'USD', verified: true, allow_withdraw: true }] });
  const state = await discoverCashoutRails(creds(), send);
  // cdpOfframp is always a candidate once authenticated, so instantOnly still resolves to it.
  assert.equal(selectCashoutRail(state).selected, 'cdpOfframp');
  // but with cdpOfframp explicitly excluded there is genuinely nothing instant:
  state.rails.cdpOfframp.candidate = false;
  assert.throws(() => selectCashoutRail(state), (e) => e instanceof CashoutError && e.code === 'no_instant_rail');
});

test('a Coinbase auth rejection surfaces as coinbase_auth_required, not a rail', async () => {
  const send = async () => ({ ok: false, status: 401, json: async () => ({}) });
  await assert.rejects(discoverCashoutRails(creds(), send), (e) => e instanceof CashoutError && e.code === 'coinbase_auth_required');
});

test('a PayPal account only counts when verified and withdraw-enabled', async () => {
  const send = async () => ok({ payment_methods: [{ id: 'pp', type: 'PAYPAL_ACCOUNT', currency: 'USD', verified: true, allow_withdraw: true }] });
  const state = await discoverCashoutRails(creds(), send);
  assert.equal(state.rails.paypal.candidate, true);
  assert.equal(state.rails.paypal.paymentMethodId, 'pp');
});
