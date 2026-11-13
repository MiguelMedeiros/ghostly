import { afterEach, describe, expect, it, vi } from "vitest";
import { createIdentity } from "../src/identity";
import { RelayTransport } from "../src/relay";
import { publishedNowhere } from "../src/transport";

// covers: core.relay-client, chat.waiting

/*
 * A publish no relay took says whether one of them may hold the packet all the same (`PublishFailedError.mayBeStored`):
 * the chat's outbox lets a text that went nowhere wait, cancellable, and keeps one that may be out queued. Only a
 * definite "not stored" counts as nowhere: not asked, refused in an answer (4xx), or a connection never made.
 */

const id = createIdentity();
afterEach(() => { vi.useRealTimers(); });

/** Node's words for a connection it could not make (undici: `TypeError: fetch failed`, its cause the socket's code). */
const refused = (code = "ECONNREFUSED") => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(`connect ${code} 127.0.0.1:1`), { code }) });
/** A relay that takes the request and never answers: this client gives up at its timeout. */
const blackHole = (init?: RequestInit) => new Promise<Response>((_, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));

type Relay = (init?: RequestInit) => Promise<Response>;
function relays(a: Relay, b: Relay) {
  return new RelayTransport({ relays: ["https://a.test", "https://b.test"], timeoutMs: 20, requestsPerMinute: Infinity,
    fetch: ((url: RequestInfo | URL, init?: RequestInit) => (String(url).includes("a.test") ? a : b)(init)) as typeof fetch });
}
const outcome = (relay: RelayTransport) => relay.publish(id, []).then(() => "published", (error: unknown) => publishedNowhere(error) ? "nowhere" : "maybe");

describe("a publish no relay took", () => {
  const no = (status: number) => async () => new Response(null, { status });
  const cases: [string, Relay, Relay, "nowhere" | "maybe"][] = [
    ["both relays refuse the connection (Node says so)", async () => { throw refused(); }, async () => { throw refused("ENOTFOUND"); }, "nowhere"],
    ["both relays answer that they did not take it (4xx)", no(400), no(403), "nowhere"],
    ["one refuses the connection, the other answers 409", async () => { throw refused(); }, no(409), "nowhere"],
    ["both relays time out", blackHole, blackHole, "maybe"],
    ["one refuses, the other times out", no(403), blackHole, "maybe"],
    ["one refuses the connection, the other answers a server error", async () => { throw refused(); }, no(503), "maybe"],
    ["a browser's TypeError, which does not say whether the request left", async () => { throw new TypeError("Failed to fetch"); }, no(403), "maybe"],
  ];
  for (const [name, a, b, expected] of cases) it(`${name}: ${expected}`, async () => {
    expect(await outcome(relays(a, b))).toBe(expected);
  });

  it("keeps the words it always had", async () => {
    const error = await relays(async () => { throw refused(); }, no(403)).publish(id, []).catch((e: Error) => e);
    expect((error as Error).message).toBe("Publish failed on every relay: Error: https://a.test did not answer; Error: https://b.test responded 403");
  });

  it("a relay not asked now (its network cooling down after a refused connection) holds nothing; one that timed out before may", async () => {
    const refusing = relays(async () => { throw refused(); }, async () => { throw refused(); });
    expect(await outcome(refusing)).toBe("nowhere");
    // Asked again within the cooldown: no request goes ("did not answer a moment ago").
    expect(await outcome(refusing)).toBe("nowhere");
    const silent = relays(blackHole, blackHole);
    expect(await outcome(silent)).toBe("maybe");
    expect(await outcome(silent)).toBe("nowhere");
  });

  it("a relay not asked now on every relay: refused before it is signed and dated, in the words it always had", async () => {
    const refusing = relays(async () => { throw refused(); }, async () => { throw refused(); });
    expect(await outcome(refusing)).toBe("nowhere");
    // Within the cooldown nothing is asked of either relay: the packet is neither dated nor signed. With every relay
    // out of reach on a page that is online, 300 chats signed ~58 packets a second that went nowhere (bug hunt, 2026-11-12).
    const dated = vi.spyOn(refusing, "nextTimestamp");
    const error = await refusing.publish(id, []).catch((e: Error) => e);
    expect(dated).not.toHaveBeenCalled();
    expect((error as Error).message).toBe("Publish failed on every relay: Error: https://a.test did not answer a moment ago; retry shortly; Error: https://b.test did not answer a moment ago; retry shortly");
    expect(publishedNowhere(error)).toBe(true);
  });

  it("every relay left alone after failing, none due for its probe: refused before it is signed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // Each answers 503: the breaker leaves it alone after a few failures; its network never cools down.
    const down = relays(no(503), no(503));
    for (let i = 0; i < 5; i++) await outcome(down);
    expect(String(await down.publish(id, []).catch((e: Error) => e))).toContain("left alone after failing");
    const dated = vi.spyOn(down, "nextTimestamp");
    const error = await down.publish(id, []).catch((e: Error) => e);
    expect(dated).not.toHaveBeenCalled();
    expect((error as Error).message).toMatch(/^Publish failed on every relay: Error: https:\/\/a\.test is left alone after failing; asked again in \d+ s; Error: https:\/\/b\.test is left alone after failing; asked again in \d+ s$/);
    expect(publishedNowhere(error)).toBe(true);
  });

  it("with no relay at all, it went nowhere", async () => {
    expect(await outcome(new RelayTransport({ relays: [] }))).toBe("nowhere");
  });

  it("taken by one relay, it is published", async () => {
    expect(await outcome(relays(no(403), async () => new Response(null, { status: 204 })))).toBe("published");
  });
});
