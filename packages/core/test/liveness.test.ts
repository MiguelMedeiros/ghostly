import { afterEach, expect, it, vi } from "vitest";
import { GhostLink, LIVENESS_MISSED_PINGS, LIVENESS_PING_MS } from "../src/ghostlink";
import { LinkSession, RELAY_POLL_INTERVALS, AWAITING_PEER_MS } from "../src/link";
import { createLink } from "../src/invite";
import { createIdentity } from "../src/identity";
// covers: core.liveness, chat.paired.reconnect

afterEach(() => { vi.useRealTimers(); });

function pairedLink() {
  return new GhostLink({ params: { ...createLink().mine, profile: "paired-chat/1" },
    pairing: { credentials: { seedB64: createIdentity().seedB64 }, pinPeer: vi.fn() },
    transport: { publish: vi.fn(async () => {}), resolve: async () => null, describe: () => ({ protocol: "test", relays: [] }) },
    createPeerConnection: () => { throw new Error("no dial in this test"); }, localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined });
}
type Internals = { channel: unknown; startLiveness(c: unknown): void; peerAnswersPings: boolean; unansweredPings: number; disconnect(): void };

it("a paired session that stops answering its pings is closed, so it can be dialled again", () => {
  vi.useFakeTimers();
  const link = pairedLink(), inner = link as unknown as Internals;
  const channel = { send: vi.fn(), close: vi.fn() };
  const disconnect = vi.spyOn(inner, "disconnect").mockImplementation(() => { inner.channel = null; });
  inner.channel = channel;
  inner.startLiveness(channel);
  inner.peerAnswersPings = true; // this peer answered before
  vi.advanceTimersByTime(LIVENESS_PING_MS * LIVENESS_MISSED_PINGS);
  expect(channel.send).toHaveBeenCalledWith(JSON.stringify({ t: "paired-ping" }));
  expect(disconnect).not.toHaveBeenCalled();
  vi.advanceTimersByTime(LIVENESS_PING_MS);
  expect(disconnect).toHaveBeenCalledOnce();
});

it("anything back from the peer keeps it alive, and a peer that never answers pings (an older app) is never cut off", () => {
  vi.useFakeTimers();
  const link = pairedLink(), inner = link as unknown as Internals;
  const channel = { send: vi.fn(), close: vi.fn() };
  const disconnect = vi.spyOn(inner, "disconnect").mockImplementation(() => {});
  inner.channel = channel;
  inner.startLiveness(channel);
  inner.peerAnswersPings = true;
  for (let i = 0; i < 10; i++) { vi.advanceTimersByTime(LIVENESS_PING_MS); inner.unansweredPings = 0; }
  expect(disconnect).not.toHaveBeenCalled();

  const old = pairedLink() as unknown as Internals;
  const oldChannel = { send: vi.fn(), close: vi.fn() };
  const oldDisconnect = vi.spyOn(old, "disconnect").mockImplementation(() => {});
  old.channel = oldChannel;
  old.startLiveness(oldChannel);
  vi.advanceTimersByTime(LIVENESS_PING_MS * 20);
  expect(oldDisconnect).not.toHaveBeenCalled();
});

it("waking a chat looks now and starts the wait between attempts over", () => {
  const link = pairedLink(), inner = link as unknown as { autoConnectFailures: number; lastAutoConnectAt: number };
  const poll = vi.spyOn(link.session, "pollNow").mockImplementation(() => {});
  inner.autoConnectFailures = 4; inner.lastAutoConnectAt = Date.now();
  link.wake();
  expect(poll).toHaveBeenCalled();
  expect(inner.autoConnectFailures).toBe(0);
  expect(inner.lastAutoConnectAt).toBe(0);
});

it("a chat whose contact was never seen keeps the active pace in the background for a while", () => {
  vi.useFakeTimers();
  const session = new LinkSession({ params: createLink().mine, pollIntervals: RELAY_POLL_INTERVALS,
    transport: { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "test", relays: [] }) } });
  const next = () => (session as unknown as { nextInterval(): number }).nextInterval();
  session.setActive(false);
  expect(next()).toBe(RELAY_POLL_INTERVALS.active);
  (session as unknown as { presence: { lastPacketAt: number } }).presence.lastPacketAt = Date.now();
  expect(next(), "a contact seen before: background pace").toBe(RELAY_POLL_INTERVALS.background);
  (session as unknown as { presence: { lastPacketAt: number } }).presence.lastPacketAt = 0;
  vi.advanceTimersByTime(AWAITING_PEER_MS + 1);
  expect(next()).toBe(RELAY_POLL_INTERVALS.background);
});
