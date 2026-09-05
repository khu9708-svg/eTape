import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFlattenSchedule, zonedNow, ScheduleError } from './kayjay-schedule.mjs';

function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kayjay-sched-'));
  return { s: createFlattenSchedule(path.join(dir, 'flatten.json')), dir };
}
const rule = over => ({ id: 'flat-eod', scope: 'engine', engine: 'ATLAS', action: 'EXIT_ENGINE', timezone: 'America/New_York', weekdays: [1, 2, 3, 4, 5], time: '15:55', enabled: true, ...over });

test('add validates and rejects bad scope/timezone/time/weekdays', () => {
  const { s, dir } = store();
  try {
    assert.throws(() => s.add(rule({ scope: 'planet' })), (e) => e instanceof ScheduleError);
    assert.throws(() => s.add(rule({ timezone: 'Mars/Olympus' })), (e) => e.code === 'timezone');
    assert.throws(() => s.add(rule({ time: '25:00' })), (e) => e.code === 'time');
    assert.throws(() => s.add(rule({ weekdays: [9] })), (e) => e.code === 'weekdays');
    assert.throws(() => s.add(rule({ scope: 'symbol', symbol: '' })), (e) => e.code === 'symbol');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('add is upsert by id; remove and setEnabled work; list persists', () => {
  const { s, dir } = store();
  try {
    s.add(rule());
    s.add(rule({ time: '16:00' }));
    assert.equal(s.list().length, 1);
    assert.equal(s.list()[0].time, '16:00');
    s.setEnabled('flat-eod', false);
    assert.equal(s.list()[0].enabled, false);
    s.remove('flat-eod');
    assert.equal(s.list().length, 0);
    assert.throws(() => s.remove('flat-eod'), (e) => e.code === 'not_found');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('due fires exactly once for a minute boundary crossed in the window, honoring timezone + weekday', () => {
  const { s, dir } = store();
  try {
    s.add(rule({ time: '15:55', timezone: 'America/New_York', weekdays: [3] })); // Wednesday
    // 2026-01-07 is a Wednesday. 15:55 America/New_York = 20:55 UTC (EST).
    const now = new Date('2026-01-07T20:55:30Z');
    const prev = new Date('2026-01-07T20:54:30Z');
    assert.equal(s.due(now, prev).length, 1);
    // A window that does not cross 20:55:00 does not fire.
    assert.equal(s.due(new Date('2026-01-07T20:56:30Z'), new Date('2026-01-07T20:55:30Z')).length, 0);
    // Wrong weekday (Thursday) does not fire.
    assert.equal(s.due(new Date('2026-01-08T20:55:30Z'), new Date('2026-01-08T20:54:30Z')).length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('disabled rules never fire; due rejects a non-forward window', () => {
  const { s, dir } = store();
  try {
    s.add(rule({ enabled: false }));
    assert.equal(s.due(new Date('2026-01-07T20:55:30Z'), new Date('2026-01-07T20:54:30Z')).length, 0);
    assert.throws(() => s.due(new Date(1000), new Date(2000)), (e) => e.code === 'window');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('zonedNow reports the local wall clock for a timezone', () => {
  const z = zonedNow(new Date('2026-01-07T20:55:00Z'), 'America/New_York');
  assert.deepEqual(z, { weekday: 3, hh: 15, mm: 55 });
});
