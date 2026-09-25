import { test, expect } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { desktopHome } from "../support/desktop";
import { LocalRelay } from "../support/relay";
import { desktopNetwork } from "../matrix/desktop";
import { desktopPerson, type DesktopPerson } from "../matrix/people";

/**
 * Two Desktop apps with no WebRTC between them go live on a native transport, from the DHT floor, by what the
 * capability record says (WISP 03, 400).
 *
 * WebKitGTK has no RTCPeerConnection, so a Linux Desktop pair can never meet over WebRTC. Before the one-chat
 * model that meant never live at all: a first pairing needed WebRTC on both sides. Now first contact is on the
 * DHT, each side publishes a capability record with its native descriptors (Iroh id and relay, HyperDHT key and
 * relay; never addresses), the other learns them (`GhostLink.learnPeerTransports`) and dials Iroh or HyperDHT
 * (`dialDescriptors`). A unit test covers the dial order; this is the two real apps doing it.
 *
 * And in good time. The descriptors reach the record only once the endpoints are up, as its next revision, and a
 * contact reads the record when an envelope names a newer one: before the envelope announced it at once
 * (`DhtDelivery.announce`), the dialling side could hear of it only with the next control envelope, four minutes
 * on, and then waited out the backoff its empty attempts had built (`learnPeerTransports` now dials at once). Live
 * took 50 s to over 5 minutes then; about 40 s now, so two minutes is the budget.
 *
 * Nothing leaves the machine: both apps read and publish on the test's Pkarr relay (GHOSTLY_PKARR_RELAYS) and
 * find each other on a HyperDHT testnet in this process (GHOSTLY_HYPERDHT_BOOTSTRAP). Iroh keeps n0's relays, so
 * on a runner with no network the pair settles on HyperDHT; either native transport passes.
 */

/**
 * Keeps, in the page, each chat state the header showed, in order: the pairing indicator's stage and the
 * connection button's label. The states can pass faster than a poll, so they are recorded as they happen.
 */
const RECORD = `
  if (window.qaStates) return;
  const states = window.qaStates = [];
  const last = {};
  const note = (kind, value) => { if (value && last[kind] !== value) { last[kind] = value; states.push(kind + ":" + value); } };
  const look = () => {
    note("stage", document.querySelector('[data-testid="pairing-indicator"]')?.getAttribute("data-stage"));
    note("label", document.querySelector('[data-testid="connection-options"]')?.getAttribute("aria-label")?.replace(/^Connection options: /, ""));
  };
  new MutationObserver(look).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-stage", "aria-label"] });
  look();`;

const states = (p: DesktopPerson) => p.app.execute<string[]>(`return window.qaStates ?? [];`);

/** How many times the open conversation shows this exact text: once, or it was lost or doubled. */
const count = (p: DesktopPerson, text: string) => p.app.execute<number>(`
  const pane = document.querySelector(".chat-wallpaper");
  return pane ? [...pane.querySelectorAll("*")].filter((e) => e.childElementCount === 0 && e.textContent === arguments[0]).length : 0;`, text);

const transport = (p: DesktopPerson) => p.app.attribute('[data-testid="connection-options"]', "data-transport");

const NATIVE = /^label:Connected · (Iroh|HyperDHT)/;

/** Each app's own log (`ghostly.log`, src-tauri/src/diagnostics.rs): its link-trace lines say what it dialled and why. */
function attachLogs(name: string, home: string): void {
  const find = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => e.isDirectory() ? find(join(dir, e.name)) : e.name === "ghostly.log" ? [join(dir, e.name)] : []);
  for (const file of find(home)) void test.info().attach(`${name}'s ghostly.log`, { body: readFileSync(file), contentType: "text/plain" });
}

test("two Desktop apps without WebRTC go live on Iroh or HyperDHT from the DHT, and nothing is lost", {
  tag: ["@feature:chat.native-upgrade", "@feature:chat.one-chat"],
}, async () => {
  test.setTimeout(10 * 60_000);
  const relay = new LocalRelay();
  const network = await desktopNetwork(relay);
  const cleanup: (() => Promise<void> | void)[] = [() => relay.close(), () => network.close()];
  try {
    const open = async (name: string): Promise<DesktopPerson> => {
      const home = desktopHome(name);
      const person = await desktopPerson(name, { home: home.dir, env: network.env });
      cleanup.push(async () => { await person.stop(); attachLogs(name, home.dir); home.remove(); });
      return person;
    };
    const a = await open("ana");
    const b = await open("bia");
    for (const p of [a, b]) {
      // The premise: this WebView has no WebRTC at all.
      expect(await p.app.execute<boolean>(`return typeof RTCPeerConnection !== "undefined";`), `${p.name} has no WebRTC`).toBe(false);
      await p.app.execute(RECORD);
    }

    await a.press("New Chat");
    const invite = await a.copyInvite();
    expect(invite).toMatch(/^https:\/\/ghostly\.tools\/#ghostly1p/);
    await b.join(invite);
    for (const p of [a, b]) {
      await expect.poll(() => p.canWrite(), { timeout: 120_000, message: `${p.name}'s chat is open` }).toBe(true);
      p.chatHash = await p.hash();
    }

    // A text while there is no live link yet goes over the DHT; the chat is usable from the start.
    await a.say("first, over the DHT");
    await expect.poll(() => count(b, "first, over the DHT"), { timeout: 180_000, message: "bia gets the DHT text" }).toBe(1);

    // Then both go live on a native transport, dialled from the other's capability record.
    for (const p of [a, b]) {
      await expect.poll(() => p.connection(), { timeout: 120_000, message: `${p.name} goes live on a native transport` })
        .toMatch(/Connected · (Iroh|HyperDHT)/);
    }
    const [onA, onB] = [await transport(a), await transport(b)];
    expect(onA, "the same transport on both sides").toBe(onB);
    expect(onA).toMatch(/^(iroh|hyperdht)\/1$/);
    test.info().annotations.push({ type: "transport", description: onA! });

    // Each side was on the DHT before it was live, never failed, and went live on the native transport.
    for (const p of [a, b]) {
      const seen = await states(p);
      const live = seen.findIndex((s) => NATIVE.test(s));
      expect(live, `${p.name} went live natively: ${seen.join(" → ")}`).toBeGreaterThanOrEqual(0);
      const before = seen.slice(0, live);
      expect(before.some((s) => s === "stage:on-dht" || s.startsWith("label:On DHT")), `${p.name} was on the DHT first: ${seen.join(" → ")}`).toBe(true);
      expect(seen, `${p.name} never showed a failed pairing`).not.toContain("stage:failed");
      test.info().annotations.push({ type: `${p.name}'s states`, description: seen.join(" → ") });
    }

    // Live: texts both ways, sent back to back, each arriving once on both sides.
    const texts: [DesktopPerson, string][] = [];
    for (let i = 1; i <= 4; i++) texts.push([a, `live from ana ${i}`], [b, `live from bia ${i}`]);
    for (const [from, text] of texts) await from.say(text);
    for (const [, text] of texts) for (const p of [a, b]) {
      await expect.poll(() => count(p, text), { timeout: 60_000, message: `${p.name} shows “${text}” once` }).toBe(1);
    }
    for (const p of [a, b]) {
      expect(await count(p, "first, over the DHT"), `${p.name} keeps the DHT text once`).toBe(1);
      expect(await p.awaitingReceipt(), `${p.name} has nothing awaiting a receipt`).toBe(false);
      // Still live on the same transport after the traffic.
      expect(await transport(p)).toBe(onA);
    }
  } finally {
    for (const done of cleanup.reverse()) await done();
  }
});
