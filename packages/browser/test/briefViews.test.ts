import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import { GhostlyNode } from "../src/engine/node";
import type { EngineState, FileTransferView } from "../src/shared/types";
// covers: groups.files

/**
 * A group's file waiting for a Download is said in one state the engine sends (the CLI's `file.offered` comes from it),
 * and is gone from the states after it: one view kept for each such file would go into every state, so each state would
 * cost more with every file the groups ever had. A view that took its place meanwhile stays.
 */
it("a brief view goes in the next state sent only, unless another view took its place", () => {
  const states: EngineState[] = [];
  const events = { onState: (state: EngineState) => void states.push(state), onMessages: vi.fn(), onCallSignal: vi.fn() };
  const transport = { publish: vi.fn(async () => {}), resolve: vi.fn(async () => null), describe: () => ({ protocol: "local fixture", relays: [] }) };
  const node = new GhostlyNode(events, { transport, automaticWallets: false });
  const inside = node as unknown as {
    transfers: Map<string, FileTransferView>;
    groups: { files: { deps: { brief(fileId: string): void } } };
    flushState(): void;
  };
  const asking: FileTransferView = { state: "transferring", stage: "asking", transferred: 0, size: 10, direction: "in" };
  const brief = (id: string, view: FileTransferView) => { inside.transfers.set(id, view); inside.groups.files.deps.brief(id); };
  brief("group-g-in-a", asking);
  brief("group-g-in-b", { ...asking });
  // Asked for before the state went: it shows how it comes from then on.
  const queued: FileTransferView = { ...asking, stage: "queued" };
  inside.transfers.set("group-g-in-b", queued);
  inside.flushState();
  expect(Object.keys(states.at(-1)!.transfers).sort()).toEqual(["group-g-in-a", "group-g-in-b"]);
  inside.flushState();
  expect(states.at(-1)!.transfers).toEqual({ "group-g-in-b": queued });
  expect(node.getState().transfers).toEqual({ "group-g-in-b": queued });
});
