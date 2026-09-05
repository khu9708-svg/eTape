// Owner-action confirmation flow — the interaction PATTERN proven by
// Uniswap/interface's transaction confirmation modals (review -> confirm ->
// pending confirmation -> pending transaction -> success/error, with a
// per-step progress indicator), reproduced here from scratch in eTape's own
// MIT-licensed code and visual identity. No Uniswap source is copied; only the
// UX state machine is followed. Uniswap's app is GPL-3.0; this file is MIT.
//
// Uniswap's StepStatus { Preview, Active, InProgress, Complete, Failed } maps
// to `StepState` below.

import type { CSSProperties, ReactNode } from "react";

export type OwnerActionPhase =
  | "enter" // amount / destination / selection entry
  | "reviewing" // fetching the quote / preview
  | "review_ready" // quote shown, awaiting explicit owner confirm
  | "confirming" // owner confirmed; request in flight to the authority
  | "submitted" // authority accepted; not yet settled/reconciled
  | "reconciling" // asking the authority/venue for the real outcome
  | "success" // reconciled terminal-good
  | "failed" // explicit rejection
  | "unknown"; // ambiguous — never auto-retry

export type StepState = "upcoming" | "active" | "running" | "done" | "failed";

export interface ProgressStep {
  key: string;
  label: string;
  state: StepState;
}

// Explicit phase -> [review, confirm, submit, reconcile] state map. Kept as a
// literal table (not derived) so the progress indicator is trivially auditable.
const STATE_TABLE: Record<OwnerActionPhase, [StepState, StepState, StepState, StepState]> = {
  enter: ["active", "upcoming", "upcoming", "upcoming"],
  reviewing: ["running", "upcoming", "upcoming", "upcoming"],
  review_ready: ["done", "active", "upcoming", "upcoming"],
  confirming: ["done", "running", "running", "upcoming"],
  submitted: ["done", "done", "done", "active"],
  reconciling: ["done", "done", "done", "running"],
  success: ["done", "done", "done", "done"],
  failed: ["done", "failed", "failed", "upcoming"],
  unknown: ["done", "failed", "failed", "upcoming"],
};

/** Build the 4-step indicator for a phase (review, confirm, submit, reconcile). */
export function stepsForPhase(phase: OwnerActionPhase, labels: [string, string, string, string]): ProgressStep[] {
  const states = STATE_TABLE[phase];
  return labels.map((label, i) => ({ key: ["review", "confirm", "submit", "reconcile"][i], label, state: states[i] }));
}

const dot: Record<StepState, string> = {
  upcoming: "○",
  active: "◔",
  running: "◑",
  done: "●",
  failed: "✕",
};

export function ProgressSteps({ steps }: { steps: ProgressStep[] }): JSX.Element {
  return (
    <ol style={{ listStyle: "none", padding: 0, margin: "8px 0", display: "flex", flexWrap: "wrap", gap: 12 }}>
      {steps.map((s) => (
        <li key={s.key} style={{ opacity: s.state === "upcoming" ? 0.5 : 1, fontWeight: s.state === "active" || s.state === "running" ? 600 : 400 }}>
          <span aria-hidden style={{ marginRight: 4 }}>{dot[s.state]}</span>
          {s.label}
          {s.state === "failed" && <span role="img" aria-label="failed"> — failed</span>}
        </li>
      ))}
    </ol>
  );
}

export function ReviewRow({ label, value, alert }: { label: string; value: ReactNode; alert?: boolean }): JSX.Element {
  return (
    <p style={{ margin: "4px 0" }} role={alert ? "alert" : undefined}>
      <span style={{ opacity: 0.7 }}>{label}: </span>
      <strong>{value}</strong>
    </p>
  );
}

/**
 * Owner-confirmation guard — reproduces Uniswap's "review then a distinct
 * confirm control" separation. For destructive actions, `requireTyped` demands
 * the owner type an exact phrase, not just tick a box.
 */
export function OwnerConfirmGate({
  requireTyped,
  typedValue,
  onTypedChange,
  checked,
  onCheckedChange,
  label,
  disabled,
}: {
  requireTyped?: string;
  typedValue?: string;
  onTypedChange?: (v: string) => void;
  checked?: boolean;
  onCheckedChange?: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}): JSX.Element {
  const fieldStyle: CSSProperties = { display: "block", margin: "8px 0" };
  if (requireTyped) {
    return (
      <label style={fieldStyle}>
        {label} — type <code>{requireTyped}</code> to confirm:{" "}
        <input
          value={typedValue ?? ""}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => onTypedChange?.(e.target.value)}
        />
      </label>
    );
  }
  return (
    <label style={fieldStyle}>
      <input type="checkbox" checked={checked ?? false} disabled={disabled} onChange={(e) => onCheckedChange?.(e.target.checked)} /> {label}
    </label>
  );
}

export function isConfirmed(gate: { requireTyped?: string; typedValue?: string; checked?: boolean }): boolean {
  if (gate.requireTyped) return (gate.typedValue ?? "").trim() === gate.requireTyped;
  return gate.checked === true;
}
