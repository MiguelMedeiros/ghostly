import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createLink } from "../src/invite";
import { LinkSession, RELAY_POLL_INTERVALS } from "../src/link";
import { RelayTransport } from "../src/relay";

// covers: core.relay-client

/**
 * Every Pkarr relay out of reach, for a contact whose packet was read before (bug hunt, 2026-11-05): the relays' last
 * copy stood for each read, and the link never said it could not read the contact, only that it could not publish.
 * The engine keeps a gone contact's HyperDHT listener while its packet cannot be read (`contactUnread`), so a contact
 * back over the HyperDHT alone found it let go, and the chat stayed offline for the whole outage, both apps up.
 */

const NOW = 1_800_000_000_000;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => void vi.useRealTimers());

it("a link whose contact was read before says it cannot read it while every relay is down, and stops once one answers", async () => {
  const stored = new Map<string, Uint8Array>();
  let down = false;
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (down) throw new TypeError("fetch failed");
    const key = new URL(String(input)).pathname.slice(1);
    if (init?.method === "PUT") { stored.set(key, new Uint8Array(init.body as ArrayBuffer)); return new Response(null, { status: 204 }); }
    const body = stored.get(key);
    return body ? new Response(body as BodyInit, { status: 200 }) : new Response(null, { status: 404 });
  }) as typeof fetch;
  const relays = ["https://a.test", "https://b.test"];
  const { mine, invite } = createLink();
  // The contact was there once and went away: its last packet stays on the relays.
  const contact = new LinkSession({ params: invite, transport: new RelayTransport({ relays, requestsPerMinute: Infinity, log: () => {}, fetch: fetchFn }),
    pollIntervals: RELAY_POLL_INTERVALS, getServices: () => [] });
  contact.start();
  await vi.advanceTimersByTimeAsync(0);
  await contact.stop(true);
  await vi.advanceTimersByTimeAsync(5 * 60_000);

  const errors: (string | null)[] = [];
  const presence: boolean[] = [];
  const link = new LinkSession({ params: mine, transport: new RelayTransport({ relays, freshReadMs: 0, log: () => {}, fetch: fetchFn }),
    pollIntervals: RELAY_POLL_INTERVALS, getServices: () => [{ id: "chat", type: "chat" }],
    events: { onDiscoveryError: error => { errors.push(error); }, onPresence: p => { presence.push(p.online); } } });
  try {
    link.start();
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(presence.length, "the contact's packet was read").toBeGreaterThan(0);
    expect(errors.filter(Boolean)).toEqual([]);

    down = true;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(errors.some(error => error?.includes("Could not read discovery")), JSON.stringify([...new Set(errors)])).toBe(true);
    // What the relays gave last still stands for the contact meanwhile.
    expect(presence.at(-1)).toBe(false);

    down = false;
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(errors.at(-1) ?? "").not.toContain("Could not read discovery");
  } finally {
    await link.stop();
  }
}, 60_000);
