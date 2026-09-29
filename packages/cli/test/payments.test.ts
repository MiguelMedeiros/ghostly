import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { error, ghostly, home, hyperdhtTestnet, localRelay, ok, Running } from "./support/cli";
// covers-gated: headless.payments, headless.wallets

/**
 * Two bots paying each other with test coins from the shared e2e stack's Cashu mint (E2E_MINT_URL, see e2e/README.md:
 * `npm run e2e:infra:use`, then `set -a; . ./.env.e2e; set +a`). Never Mainnet: a Mainnet spend is only checked to
 * be refused without --confirm-real.
 */
const MINT = process.env.E2E_MINT_URL;
let relay: { url: string; server: Server };
let dht: { bootstrap: string; destroy(): Promise<void> };
const running: Running[] = [];
const alice = home("pay-alice"), bob = home("pay-bob");
let env: NodeJS.ProcessEnv;
const as = (dir: string, ...args: string[]) => ghostly(["--home", dir, ...args], { env });
async function balance(dir: string): Promise<number> {
  const wallets = ok(await as(dir, "wallet", "list", "--network", "testnet")).wallets as { type: string; balance: number }[];
  return wallets.find((w) => w.type === "cashu")?.balance ?? 0;
}
async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 60_000): Promise<T> {
  const until = Date.now() + ms;
  let value = await read();
  while (!done(value) && Date.now() < until) { await new Promise((r) => setTimeout(r, 1000)); value = await read(); }
  return value;
}

describe.skipIf(!MINT)("two bots pay each other (test coins)", { timeout: 240_000 }, () => {
  let chatA = "";
  beforeAll(async () => {
    relay = await localRelay();
    dht = await hyperdhtTestnet();
    // The stack's mint is on loopback with a fake Lightning backend, and issues Bitcoin (lnbc) invoices: declared a test mint.
    env = { GHOSTLY_HYPERDHT_BOOTSTRAP: dht.bootstrap, GHOSTLY_TEST_MINTS: MINT };
    for (const [dir, name] of [[alice, "Payer"], [bob, "Payee"]] as const) {
      ok(await as(dir, "settings", "set", "relays", JSON.stringify([relay.url])));
      ok(await as(dir, "profile", "set", "--name", name));
      const daemon = new Running(["--home", dir, "daemon"], env);
      running.push(daemon);
      await daemon.waitFor((l) => l.daemon === "ready");
      ok(await as(dir, "wallet", "create", "cashu"));
      ok(await as(dir, "wallet", "add-mint", MINT!, "--primary"));
    }
    const invite = ok(await as(alice, "invite", "create", "--label", "payee"));
    chatA = invite.chat as string;
    ok(await as(bob, "invite", "join", invite.invite as string, "--label", "payer"));
    ok(await as(alice, "chat", "wait", chatA, "--until", "live", "--timeout", "90"));
  }, 180_000);

  afterAll(async () => {
    await Promise.all(running.map((r) => r.stop()));
    await dht?.destroy();
    relay?.server.close();
  }, 30_000);

  it("fund from the faucet, pay in the chat, request and get paid, pay an invoice", async () => {
    expect(ok(await as(alice, "wallet", "faucet", "cashu"))).toMatchObject({ unit: "test sats" });
    const funded = await balance(alice);
    expect(funded).toBeGreaterThan(100);

    const events = new Running(["--home", bob, "listen", "--type", "payment."], env);
    running.push(events);
    await new Promise((r) => setTimeout(r, 500));
    const paid = ok(await as(alice, "chat", "pay", "payee", "21", "--memo", "tip"));
    const received = await events.waitFor((e) => e.type === "payment.created" && (e.payment as { id: string }).id === paid.paymentId);
    expect(received.payment).toMatchObject({ kind: "payment", direction: "in", amount: 21, memo: "tip", network: "testnet" });
    expect(await eventually(() => balance(bob), (b) => b >= 21)).toBeGreaterThanOrEqual(21);

    // Real money is refused without the flag, before anything moves.
    error(await as(alice, "chat", "pay", "payee", "21", "--network", "mainnet"), "confirm", 5);

    const request = ok(await as(bob, "chat", "request", "payer", "5", "--memo", "for the bot"));
    const incoming = await eventually(async () => (ok(await as(alice, "payment", "list", "--chat", "payee")).payments as { id: string; state: string }[]), (list) => list.some((p) => p.id === request.paymentId));
    expect(incoming.find((p) => p.id === request.paymentId)).toMatchObject({ state: "pending" });
    ok(await as(alice, "chat", "pay-request", "payee", request.paymentId as string));
    await events.waitFor((e) => e.type === "payment.updated" && (e.payment as { id: string; state: string }).id === request.paymentId && (e.payment as { state: string }).state === "settled");

    // An invoice paid from the payer's Lightning. (A test mint's own invoice stays held on the payee's side until a
    // payer vouches in a chat, #291: a test mint says every invoice is paid, so only the payer's side is checked here.)
    const before = await balance(alice);
    const invoice = ok(await as(bob, "wallet", "receive", "7"));
    expect(ok(await as(alice, "pay", invoice.invoice as string, "--max-fee", "10"))).toMatchObject({ network: "testnet", amount: 7, paid: true });
    expect(await eventually(() => balance(alice), (b) => b <= before - 7)).toBeLessThanOrEqual(before - 7);
  });
});
