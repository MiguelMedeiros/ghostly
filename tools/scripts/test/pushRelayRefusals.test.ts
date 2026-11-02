import { afterEach, describe, expect, it } from "vitest";
import { refusalLog, startRelay } from "../../../infra/services/push-relay/relay.mjs";

// covers: push.wake.send

const body = Buffer.from("encrypted").toString("base64url");
const request = (patch: Record<string, unknown> = {}) => JSON.stringify({
  endpoint: "https://example.com/x", headers: { Authorization: "vapid t=a.b.c, k=K" }, body, ...patch,
});

describe("the push relay's log of refusals (infra/services/push-relay)", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => { await close?.(); close = undefined; });

  it("logs each kind of refusal an operator would look for: origin, method, rate, size", async () => {
    const lines: string[] = [];
    const relay = await startRelay({ origins: ["https://app.ghostly.tools"], limits: { perMinute: 3 }, log: (...words: unknown[]) => lines.push(words.join(" ")) });
    close = relay.close;
    const url = `http://127.0.0.1:${relay.port}/`;
    const post = (init: RequestInit = {}) => fetch(url, { method: "POST", headers: { Origin: "https://app.ghostly.tools" }, body: request(), ...init });
    expect((await fetch(url)).status).toBe(405);
    expect((await post({ headers: { Origin: "https://evil.example" } })).status).toBe(403);
    // The preflight of a refused page is answered (so its POST gets a 403 it can read): no refusal of its own.
    expect((await fetch(url, { method: "OPTIONS", headers: { Origin: "https://evil.example" } })).status).toBe(204);
    expect((await post({ body: request({ memo: "x".repeat(20_000) }) })).status).toBe(413);
    expect((await post()).status).toBe(400);
    expect((await post()).status).toBe(400);
    expect((await post()).status).toBe(429);
    expect(lines).toEqual(["refused method", 'refused origin "https://evil.example"', "refused size", "refused Not a push service", "refused rate"]);
  });

  it("names no header the client chose", async () => {
    const lines: string[] = [];
    const relay = await startRelay({ log: (...words: unknown[]) => lines.push(words.join(" ")) });
    close = relay.close;
    const answer = await fetch(`http://127.0.0.1:${relay.port}/`, { method: "POST", headers: { Origin: "https://app.ghostly.tools" }, body: request({ endpoint: "https://fcm.googleapis.com/x", headers: { Authorization: "vapid t=a.b.c, k=K", "X-Mine\nforged line": "1", "x-mine\nforged line": "1" } }) });
    expect(answer.status).toBe(400);
    expect(lines).toEqual(["refused header twice"]);
  });

  it("logs the first refusal of a kind at once and the rest of the minute as one count", () => {
    const lines: string[] = [];
    const refusals = refusalLog((...words: unknown[]) => lines.push(words.join(" ")));
    for (let i = 0; i < 30; i++) refusals.refuse("rate");
    refusals.refuse("origin");
    expect(lines).toEqual(["refused rate", "refused origin"]);
    refusals.flush();
    expect(lines.slice(2)).toEqual(["refused rate 29 more"]);
    // Still refusing a minute later: one line a minute.
    refusals.refuse("rate");
    refusals.refuse("rate");
    refusals.flush();
    expect(lines.slice(3)).toEqual(["refused rate 2 more"]);
    // A quiet minute: the next one is logged at once again.
    refusals.flush();
    refusals.refuse("rate");
    expect(lines.slice(4)).toEqual(["refused rate"]);
  });

  it("puts a refusal's detail on the first line of its kind only: the count covers the rest", () => {
    const lines: string[] = [];
    const refusals = refusalLog((...words: unknown[]) => lines.push(words.join(" ")));
    refusals.refuse("origin", '"https://a.example"');
    refusals.refuse("origin", '"https://b.example"');
    refusals.refuse("origin", "(none)");
    refusals.flush();
    refusals.flush();
    refusals.refuse("origin", '"https://b.example"');
    expect(lines).toEqual(['refused origin "https://a.example"', "refused origin 2 more", 'refused origin "https://b.example"']);
    expect(refusals.total()).toBe(4);
  });

  it("logs what is still uncounted when it stops", async () => {
    const lines: string[] = [];
    const relay = await startRelay({ limits: { perMinute: 1 }, log: (...words: unknown[]) => lines.push(words.join(" ")) });
    const post = () => fetch(`http://127.0.0.1:${relay.port}/`, { method: "POST", headers: { Origin: "https://app.ghostly.tools" }, body: request() });
    for (let i = 0; i < 4; i++) await post();
    await relay.close();
    expect(lines).toEqual(["refused Not a push service", "refused rate", "refused rate 2 more"]);
  });
});
