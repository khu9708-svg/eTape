import { useSyncExternalStore } from "react";
import type { VenueID, ExecStatus } from "../../wire/contract";
import type { Stores } from "../../data/registry";
import type { LinkGroup, LinkGroups } from "../linkGroups";

// A group venue is usable if it's non-empty and, once status has loaded, still
// names a venue the engine actually runs. This prevents a persisted venue from
// crossing a mode transition and becoming an unknown-venue order target.
// status === null means no snapshot has arrived yet (nothing to validate
// against), so a candidate is trusted as-is in that case.
function isLiveVenue(v: VenueID | undefined, status: ExecStatus | null): v is VenueID {
  return !!v && (status === null || status.venues.some((s) => s.venue === v));
}

// A grouped panel resolves only its Link Group venue. Pinned panels deliberately
// have no execution venue: this removes the hidden global venue fallback.
export function resolveVenue(
  group: LinkGroup,
  linkGroups: LinkGroups,
  _legacyActiveVenue: VenueID | undefined,
  status: ExecStatus | null,
): VenueID {
  if (group === null) return "";
  const grouped = linkGroups.venueFor(group);
  if (isLiveVenue(grouped, status)) return grouped;
  return "";
}

// Hook form for panels: returns the resolved venue, the full venue-id list, and
// a setter that writes group-focus for grouped panels. Pinned panels have no
// setter because they deliberately have no execution venue. Subscribes to both
// the link bus (venue re-pick) and the exec store (venue list changes) so the
// panel re-renders.
export function useVenueSelection(
  group: LinkGroup,
  linkGroups: LinkGroups,
  stores: Stores,
): { venue: VenueID; venues: VenueID[]; selectVenue: (v: VenueID) => void } {
  useSyncExternalStore((cb) => linkGroups.subscribe(cb), () => linkGroups.venueFor(group));
  useSyncExternalStore((cb) => stores.exec.subscribe(cb), () => stores.exec.getSnapshot());
  const status = stores.exec.status();
  const venues = status?.venues.map((v) => v.venue) ?? [];
  const venue = resolveVenue(group, linkGroups, undefined, status);
  const selectVenue = (v: VenueID) => {
    if (group !== null) linkGroups.focusVenue(group, v);
  };
  return { venue, venues, selectVenue };
}

export function requiresLiveConfirmation(status: ExecStatus | null, current: VenueID, next: VenueID): boolean {
  if (!current || current === next || !status) return false;
  const env = (v: VenueID) => status.venues.find((s) => s.venue === v)?.env?.toLowerCase();
  return env(current) === "paper" && env(next) === "live";
}
