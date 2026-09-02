import { useEffect } from "react";
import type { AckMsg } from "../../wire/contract";

type CommandSender = { sendCommand(name: string, args: unknown): Promise<AckMsg> };

// Account demand is panel-scoped and venue-scoped. Cleanup releases the old
// venue before a group switch or connection teardown, so the engine can stop
// display polling when the last panel leaves a venue.
export function useAccountDemand(commands: CommandSender, panelId: string, venue: string): void {
  useEffect(() => {
    const args = { panelId, venue };
    void commands.sendCommand("SetAccountDemand", args);
    return () => {
      void commands.sendCommand("SetAccountDemand", { panelId, venue: "" });
    };
  }, [commands, panelId, venue]);
}
