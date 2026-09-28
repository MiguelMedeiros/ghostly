import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ghostly, home, ok, Running } from "./support/cli";
// covers-gated: headless.wallets

/**
 * A Fedimint wallet on Node against the shared e2e stack's regtest federation (e2e/support/fedimint-regtest: a
 * guardian, an LND gateway and an LND peer with a channel to it). Test coins only. It runs where the guardian's API
 * answers on this machine (`npm run e2e:infra:use`, or the stack itself) and `docker` reaches the stack; elsewhere it
 * is skipped.
 */
const ROOT = resolve(import.meta.dirname, "../../..");
const API = new URL((process.env.GHOSTLY_FEDIMINT_API_URL ?? "ws://127.0.0.1:47095").replace(/^ws/, "http"));
const regtest = (...args: string[]) => execFileSync(process.execPath, [join(ROOT, "e2e/support/fedimint-regtest/regtest.mjs"), ...args], { encoding: "utf8", stdio: "pipe", timeout: 600_000 }).trim();

function answers(url: URL): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect(Number(url.port), url.hostname);
    socket.setTimeout(2000);
    socket.once("connect", () => { socket.destroy(); done(true); });
    socket.once("timeout", () => { socket.destroy(); done(false); });
    socket.once("error", () => done(false));
  });
}
const reachable = await answers(API) && (() => { try { return regtest("invite").startsWith("fed1"); } catch { return false; } })();

const dir = home("fedimint");
const as = (...args: string[]) => ghostly(["--home", dir, ...args]);
async function sats(type: "fedimint" | "lightning"): Promise<number> {
  const wallets = ok(await as("wallet", "list", "--network", "testnet")).wallets as { type: string; balance: number | null }[];
  return wallets.find((w) => w.type === type)?.balance ?? 0;
}
async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 90_000): Promise<T> {
  const until = Date.now() + ms;
  let value = await read();
  while (!done(value) && Date.now() < until) { await new Promise((r) => setTimeout(r, 1000)); value = await read(); }
  return value;
}

describe.skipIf(!reachable)("a Fedimint wallet on Node (regtest)", { timeout: 300_000 }, () => {
  let daemon: Running;
  const invite = reachable ? regtest("invite") : "";
  beforeAll(async () => {
    daemon = new Running(["--home", dir, "daemon"]);
    await daemon.waitFor((l) => l.daemon === "ready");
  }, 60_000);
  afterAll(async () => { await daemon?.stop(); }, 30_000);

  it("previews, joins by invite, receives over the gateway, pays out, and keeps its database in the profile", async () => {
    // The federation shows itself first, as New does in the app (a scratch database, removed after).
    const preview = ok(await as("engine", "fedimintPreview", JSON.stringify({ invite, network: "testnet" })));
    expect(preview).toMatchObject({ name: "Ghostly regtest", network: "regtest", federationId: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const federation = preview.federationId as string;

    // New offers Fedimint on Node now, and joins in a worker thread.
    const offers = ok(await as("wallet", "list", "--network", "testnet")).offers as { type: string; available: boolean }[];
    expect(offers.find((o) => o.type === "fedimint")).toMatchObject({ available: true });
    expect(ok(await as("wallet", "create", "fedimint", "--invite", invite))).toMatchObject({ type: "fedimint", network: "testnet", balance: 0 });
    const files = readdirSync(join(dir, "profiles/default/fedimint"));
    expect(files).toEqual([expect.stringMatching(/^ghostly-fedimint-[\w-]+\.db$/)]);

    // Its Lightning card, on the federation's gateway.
    const card = ok(await as("wallet", "create", "lightning", "--provider", "fedimint", "--value", `federation=${federation}`));
    expect(card).toMatchObject({ type: "lightning", config: { providerId: "fedimint" } });

    // In: the LND peer pays our invoice through the gateway.
    const received = ok(await as("wallet", "receive", "2000", "--card", card.card as string));
    expect(received.invoice).toMatch(/^lnbcrt20u/);
    expect(JSON.parse(regtest("pay", received.invoice as string)).status).toBe("SUCCEEDED");
    // Less the gateway's fee for bringing it in.
    const funded = await eventually(() => sats("fedimint"), (b) => b > 0);
    expect(funded).toBeGreaterThan(1900);
    expect(funded).toBeLessThanOrEqual(2000);

    // Out: we pay the peer's invoice from the card; the gateway routes it.
    const outside = JSON.parse(regtest("invoice", "500")) as { payment_request: string; r_hash: string };
    expect(ok(await as("pay", outside.payment_request, "--card", card.card as string))).toMatchObject({ amount: 500, paid: true });
    expect(await eventually(async () => JSON.parse(regtest("lookup", outside.r_hash)).state as string, (s) => s === "SETTLED")).toBe("SETTLED");
    // 500 and the gateway's fee.
    const after = await eventually(() => sats("fedimint"), (b) => b <= funded - 500);
    expect(after).toBeLessThanOrEqual(funded - 500);
    expect(after).toBeGreaterThan(funded - 520);

    // A restart opens the same database: the balance is still there.
    await daemon.stop();
    daemon = new Running(["--home", dir, "daemon"]);
    await daemon.waitFor((l) => l.daemon === "ready");
    expect(await eventually(() => sats("fedimint"), (b) => b === after, 30_000)).toBe(after);
    expect(existsSync(join(dir, "profiles/default/fedimint", files[0]))).toBe(true);
  });
});
