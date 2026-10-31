import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLink } from "../src/invite";
import { CarriedTransport } from "../src/groupSignals";
import { LinkSession, RELAY_POLL_INTERVALS } from "../src/link";
import type { GhostRecord } from "../src/pkarr";
import { buildLinkRecords } from "../src/records";
import { DiscoveryBudgetError, type PkarrTransport } from "../src/transport";
import { identityFromSeedB64, type Identity } from "../src/identity";

// covers: core.records

vi.mock("../src/records", async (original) => {
  const records = await original<typeof import("../src/records")>();
  return { ...records, buildLinkRecords: vi.fn(records.buildLinkRecords) };
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(buildLinkRecords).mockClear();
});
afterEach(() => void vi.useRealTimers());

function relays() {
  const t = {
    held: true,
    publish: vi.fn(async (_identity: Identity, _records: GhostRecord[]) => {}),
    publishHeld: vi.fn(() => (t.held ? new DiscoveryBudgetError(5_000) : null)),
    resolve: vi.fn(async () => null),
    describe: () => ({ protocol: "memory", relays: [] }),
  };
  return t satisfies PkarrTransport;
}

/** A chat that owes an acknowledgement publishes as it starts. */
function chat(transport: PkarrTransport) {
  return new LinkSession({ params: createLink().mine, transport, pollIntervals: RELAY_POLL_INTERVALS, events: {}, lastSeenTimestamp: 5 });
}

describe("a chat's publish the relays' budget holds back", () => {
  it("builds no packet: it goes when the wait is over", async () => {
    const transport = relays();
    const link = chat(transport);
    link.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(buildLinkRecords).not.toHaveBeenCalled();
    expect(transport.publish).not.toHaveBeenCalled();

    transport.held = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(buildLinkRecords).toHaveBeenCalled();
    expect(transport.publish).toHaveBeenCalled();
    await link.stop();
  });

  it("a group edge that is down still hands its packet to members, whatever the relays' budget says", async () => {
    const inner = relays();
    const params = createLink().mine;
    const carry = vi.fn(() => ({ taken: 1, sure: true }));
    const edge = new CarriedTransport(inner, identityFromSeedB64(params.seedB64).pubKeyZ32, params.peerPubKeyZ32, { carry, open: () => false, look: () => {} });
    const link = new LinkSession({ params, transport: edge, pollIntervals: RELAY_POLL_INTERVALS, events: {}, lastSeenTimestamp: 5 });
    link.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(carry).toHaveBeenCalled();
    await link.stop();
  });
});
