import type { Palette } from "../palette";
import type { LineStyleName } from "./lineStyle";
import { INDICATOR_LINE_WIDTH } from "./chartTheme";

export type IndicatorType = "VWAP" | "EMA" | "SMA" | "MACD" | "VOLUME";

export const CHART_INDICATOR_MODEL_VERSION = 1;

export function volumeInstanceId(panelId: string): string { return `${panelId}:VOLUME`; }

// A per-chart indicator instance. `params` and `colors` are the customizable state,
// persisted with the workspace (Task 9). `colors` is keyed by slot; unset slots use
// the palette default (so they re-theme automatically on light/dark switch).
export interface IndicatorInstance {
  instanceId: string;
  type: IndicatorType;
  params: Record<string, number>;
  colors?: Record<string, string>;
  styles?: Record<string, SlotStyle>; // per-slot style overrides (color/width/lineStyle/hidden)
  hidden?: boolean;                    // legend 👁 toggle — mapped to LWC series `visible`
  collapsed?: boolean;                 // sub-pane collapsed to a thin strip (e.g. MACD's pane)
}

export interface SlotStyle { color?: string; width?: number; lineStyle?: LineStyleName; hidden?: boolean }

export interface ParamSpec { key: string; label: string; default: number; min: number; max: number }
export interface SlotSpec { slot: string; kind: "line" | "histogram"; paneIndex: number; paletteKey: keyof Palette }
export interface CatalogEntry { type: IndicatorType; label: string; params: ParamSpec[]; slots: SlotSpec[] }

export function defaultVolumeIndicator(panelId: string): IndicatorInstance {
  return { instanceId: volumeInstanceId(panelId), type: "VOLUME", params: {}, hidden: false };
}

export interface SeriesDescriptor {
  key: string;         // unique LWC series id: instanceId (single-slot) or `${instanceId}#${slot}`
  slot: string;        // stable slot name — the persistable color key
  kind: "line" | "histogram";
  paneIndex: number;   // 0 = main pane, 1 = MACD sub-pane
  color: string;       // resolved: inst.colors?.[slot] ?? palette[slot's default key]
  width: number;           // resolved: styles[slot].width ?? INDICATOR_LINE_WIDTH
  lineStyle: LineStyleName; // resolved: styles[slot].lineStyle ?? "solid"
  hidden: boolean;          // resolved: styles[slot].hidden ?? false — per-slot visibility (e.g. MACD histogram)
}

const MAIN = 0, SUBPANE = 1;

// The v1 indicator catalog: every type's editable params (defaults + bounds) and
// drawable slots (with the palette key each defaults to). The management UI (Task 9)
// renders inputs from `params` and color pickers from `slots`.
export const INDICATOR_CATALOG: Record<IndicatorType, CatalogEntry> = {
  VWAP:   { type: "VWAP",   label: "VWAP",       params: [], slots: [{ slot: "line", kind: "line", paneIndex: MAIN, paletteKey: "indVwap" }] },
  EMA:    { type: "EMA",    label: "EMA",        params: [{ key: "period", label: "Period", default: 9,  min: 1, max: 400 }], slots: [{ slot: "line", kind: "line", paneIndex: MAIN, paletteKey: "indEma" }] },
  SMA:    { type: "SMA",    label: "SMA",        params: [{ key: "period", label: "Period", default: 20, min: 1, max: 400 }], slots: [{ slot: "line", kind: "line", paneIndex: MAIN, paletteKey: "indSma" }] },
  VOLUME: { type: "VOLUME", label: "Volume",     params: [], slots: [{ slot: "hist", kind: "histogram", paneIndex: MAIN, paletteKey: "indMacdHist" }] },
  MACD:   { type: "MACD",   label: "MACD",
            params: [
              { key: "fast",   label: "Fast",   default: 12, min: 1, max: 200 },
              { key: "slow",   label: "Slow",   default: 26, min: 1, max: 400 },
              { key: "signal", label: "Signal", default: 9,  min: 1, max: 200 },
            ],
            slots: [
              { slot: "macd",   kind: "line",      paneIndex: SUBPANE, paletteKey: "indMacdLine" },
              { slot: "signal", kind: "line",      paneIndex: SUBPANE, paletteKey: "indMacdSignal" },
              { slot: "hist",   kind: "histogram", paneIndex: SUBPANE, paletteKey: "indMacdHist" },
            ] },
};

export function volumeIsVisible(inst: IndicatorInstance): boolean {
  return inst.type === "VOLUME" && !(inst.hidden ?? false) && !(inst.styles?.hist?.hidden ?? false);
}

export function volumeColorFor(inst: IndicatorInstance, p: Palette, up: boolean): string {
  const override = inst.styles?.hist?.color ?? inst.colors?.hist;
  return validColor(override) ? override : up ? p.volUp : p.volDown;
}

interface NormalizedChartIndicators {
  instances: IndicatorInstance[];
  changed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validColor(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isKnownInstance(value: unknown): value is IndicatorInstance {
  if (!isRecord(value) || typeof value.instanceId !== "string" || typeof value.type !== "string") return false;
  return INDICATOR_CATALOG[value.type as IndicatorType] !== undefined;
}

function histogramColor(inst: IndicatorInstance): string | undefined {
  const styleColor = inst.styles?.hist?.color;
  if (validColor(styleColor)) return styleColor;
  const legacyColor = inst.colors?.hist;
  return validColor(legacyColor) ? legacyColor : undefined;
}

function canonicalVolume(inst: IndicatorInstance, panelId: string): IndicatorInstance {
  const hist = inst.styles?.hist;
  const style: SlotStyle = {};
  if (validColor(hist?.color)) style.color = hist.color;
  if (typeof hist?.hidden === "boolean") style.hidden = hist.hidden;
  return {
    instanceId: volumeInstanceId(panelId), type: "VOLUME", params: {},
    ...(typeof inst.hidden === "boolean" ? { hidden: inst.hidden } : {}),
    ...(Object.keys(style).length > 0 ? { styles: { hist: style } } : {}),
  };
}

// Normalizes persisted chart indicators at the Chart Panel boundary. The
// unversioned branch unions the old built-in toggle with any catalog Volume
// instances; the current branch only enforces the singleton and stable ID.
export function normalizeChartIndicators(
  panelId: string, raw: unknown, modelVersion: unknown, legacyVolumeVisible: unknown,
): NormalizedChartIndicators {
  const source = Array.isArray(raw) ? raw.filter(isKnownInstance) : [];
  const volumes = source.filter((inst) => inst.type === "VOLUME");
  const generic = source.filter((inst) => inst.type !== "VOLUME");
  const firstVolumeIndex = source.findIndex((inst) => inst.type === "VOLUME");
  const insertVolume = (inst: IndicatorInstance): IndicatorInstance[] => {
    if (firstVolumeIndex < 0) return [...generic, inst];
    const genericBefore = source.slice(0, firstVolumeIndex).filter((candidate) => candidate.type !== "VOLUME").length;
    return [...generic.slice(0, genericBefore), inst, ...generic.slice(genericBefore)];
  };

  if (modelVersion !== CHART_INDICATOR_MODEL_VERSION) {
    const visibleAdded = volumes.find((inst) => volumeIsVisible(inst));
    const visible = legacyVolumeVisible !== false || visibleAdded !== undefined;
    const coloredAdded = volumes.find((inst) => volumeIsVisible(inst) && histogramColor(inst) !== undefined);
    const color = coloredAdded ? histogramColor(coloredAdded) : undefined;
    const canonical = { ...defaultVolumeIndicator(panelId), hidden: !visible,
      ...(color ? { styles: { hist: { color } } } : {}) };
    return { instances: insertVolume(canonical), changed: true };
  }

  const currentVolume = volumes.find((inst) => inst.instanceId === volumeInstanceId(panelId)) ?? volumes[0];
  const canonical = currentVolume ? canonicalVolume(currentVolume, panelId) : null;
  const instances = canonical ? insertVolume(canonical) : generic;
  return { instances, changed: JSON.stringify(instances) !== JSON.stringify(source) };
}

// Fill any params the user hasn't set with the catalog defaults.
export function withDefaultParams(type: IndicatorType, params: Record<string, number> = {}): Record<string, number> {
  const out = { ...params };
  for (const p of INDICATOR_CATALOG[type].params) if (out[p.key] === undefined) out[p.key] = p.default;
  return out;
}

export function describeIndicator(inst: IndicatorInstance, p: Palette): SeriesDescriptor[] {
  const entry = INDICATOR_CATALOG[inst.type];
  const single = entry.slots.length === 1;
  return entry.slots.map((s) => {
    const style = inst.styles?.[s.slot];
    return {
      key: single ? inst.instanceId : `${inst.instanceId}#${s.slot}`,
      slot: s.slot,
      kind: s.kind,
      paneIndex: s.paneIndex,
      color: style?.color ?? inst.colors?.[s.slot] ?? p[s.paletteKey],
      width: style?.width ?? INDICATOR_LINE_WIDTH,
      lineStyle: style?.lineStyle ?? "solid",
      hidden: style?.hidden ?? false,
    };
  });
}
