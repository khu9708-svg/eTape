// Scheduled flatten. Rules describe WHEN and WHAT to exit; a coordinator (the
// caller) issues the actual EXIT via the existing control authority. Scheduled
// flatten sits above AUTO strategy and never changes an engine's long-term mode.
//
// Rule shape:
//   { id, scope: "engine"|"symbol"|"global", engine?, symbol?,
//     action: "EXIT_POSITION"|"EXIT_SYMBOL"|"EXIT_ENGINE"|"EXIT_ALL",
//     timezone (IANA), weekdays: number[] (0=Sun..6=Sat), time: "HH:MM",
//     maxHoldSeconds?, enabled }
import fs from "node:fs";

export class ScheduleError extends Error {
  constructor(code, message) { super(message); this.name = "ScheduleError"; this.code = code; }
}
const fail = (code, message) => { throw new ScheduleError(code, message); };

const ID = /^[a-zA-Z0-9_-]{4,64}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ACTIONS = ["EXIT_POSITION", "EXIT_SYMBOL", "EXIT_ENGINE", "EXIT_ALL"];
const ENGINES = ["JINX", "ATLAS", "RAPTOR15"];

function validRule(r) {
  if (!r || !ID.test(r.id ?? "")) fail("id", "A stable rule id (4-64 chars) is required.");
  if (!["engine", "symbol", "global"].includes(r.scope)) fail("scope", "scope must be engine, symbol or global.");
  if (!ACTIONS.includes(r.action)) fail("action", `action must be one of ${ACTIONS.join(", ")}.`);
  if (r.scope !== "global" && !ENGINES.includes(r.engine ?? "")) fail("engine", "engine is required for engine/symbol scope.");
  if (r.scope === "symbol" && (typeof r.symbol !== "string" || !/^[A-Za-z0-9._:-]{1,40}$/.test(r.symbol))) fail("symbol", "A valid symbol is required for symbol scope.");
  if (typeof r.timezone !== "string" || !r.timezone) fail("timezone", "An IANA timezone is required.");
  try { new Intl.DateTimeFormat("en-US", { timeZone: r.timezone }); } catch { fail("timezone", `Unknown timezone: ${r.timezone}`); }
  if (!Array.isArray(r.weekdays) || !r.weekdays.length || r.weekdays.some(d => !Number.isInteger(d) || d < 0 || d > 6)) fail("weekdays", "weekdays must be a non-empty array of 0-6.");
  if (!HHMM.test(r.time ?? "")) fail("time", "time must be HH:MM (24h).");
  if (r.maxHoldSeconds != null && (!Number.isSafeInteger(r.maxHoldSeconds) || r.maxHoldSeconds <= 0)) fail("max_hold", "maxHoldSeconds must be a positive integer.");
  return {
    id: r.id, scope: r.scope, engine: r.scope === "global" ? null : r.engine,
    symbol: r.scope === "symbol" ? r.symbol : null, action: r.action,
    timezone: r.timezone, weekdays: [...new Set(r.weekdays)].sort(), time: r.time,
    maxHoldSeconds: r.maxHoldSeconds ?? null, enabled: r.enabled !== false,
  };
}

// Local wall-clock {weekday, hh, mm} for an instant in a timezone.
export function zonedNow(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(date);
  const get = t => parts.find(p => p.type === t)?.value;
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[get("weekday")];
  return { weekday: wd, hh: Number(get("hour")) % 24, mm: Number(get("minute")) };
}

export function createFlattenSchedule(file) {
  function read() {
    try { const v = JSON.parse(fs.readFileSync(file, "utf8")); return Array.isArray(v) ? v : []; }
    catch (e) { if (e.code === "ENOENT") return []; fail("state", "Schedule state cannot be read."); }
  }
  function write(rules) { fs.writeFileSync(file, JSON.stringify(rules), { mode: 0o600 }); }
  return {
    list: () => read(),
    add(rule) {
      const clean = validRule(rule);
      const rules = read().filter(r => r.id !== clean.id);
      rules.push(clean); write(rules); return clean;
    },
    remove(id) {
      if (!ID.test(id ?? "")) fail("id", "A valid rule id is required.");
      const rules = read(); const next = rules.filter(r => r.id !== id);
      if (next.length === rules.length) fail("not_found", "No such schedule rule.");
      write(next); return { removed: id };
    },
    setEnabled(id, enabled) {
      const rules = read(); const rule = rules.find(r => r.id === id);
      if (!rule) fail("not_found", "No such schedule rule.");
      rule.enabled = enabled === true; write(rules); return rule;
    },
    /**
     * Rules that should fire within [prev, now). `prev` is the last check
     * instant (persisted by the caller); a minute boundary crossed in that
     * window fires exactly once. Pure given the two instants.
     */
    due(now = new Date(), prev = new Date(now.getTime() - 60000)) {
      if (!(now instanceof Date) || !(prev instanceof Date) || prev >= now) fail("window", "due() needs prev < now Date instants.");
      return read().filter(rule => {
        if (!rule.enabled) return false;
        // Walk each whole minute in (prev, now].
        for (let t = Math.ceil(prev.getTime() / 60000) * 60000; t <= now.getTime(); t += 60000) {
          const z = zonedNow(new Date(t), rule.timezone);
          const [hh, mm] = rule.time.split(":").map(Number);
          if (rule.weekdays.includes(z.weekday) && z.hh === hh && z.mm === mm) return true;
        }
        return false;
      });
    },
  };
}
