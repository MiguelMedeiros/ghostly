import type { WebLNProvider } from "../../packages/browser/src/engine/paymentAdapters/providers/webln";
import { createWallet, expect, type Peer } from "./fixtures";

const METHODS = ["enable", "getInfo", "makeInvoice", "sendPayment", "getBalance", "lookupInvoice"] as const;

/**
 * Puts a browser wallet in this person's page, the way Alby injects `window.webln`: every call goes to
 * `wallet`, which lives in the test process (an in-memory fake, or a real regtest LND node behind
 * support's lndWebln). Only the methods `wallet` has are injected. The page reloads so the app starts
 * with it, like a wallet that is installed.
 */
export async function installWebln(peer: Peer, wallet: WebLNProvider): Promise<void> {
  const has = METHODS.filter((m) => typeof wallet[m] === "function");
  await peer.context.exposeBinding("__ghostlyWebln", async (_source, method: (typeof METHODS)[number], args: unknown[]) => {
    if (!has.includes(method)) throw new Error(`${method} is not supported`);
    return (wallet[method] as (...a: unknown[]) => Promise<unknown>).apply(wallet, args);
  });
  await peer.context.addInitScript((methods: readonly string[]) => {
    const page = window as unknown as { webln: unknown; __ghostlyWebln(method: string, args: unknown[]): Promise<unknown> };
    page.webln = Object.fromEntries(methods.map((m) => [m, (...args: unknown[]) => page.__ghostlyWebln(m, args)]));
    window.dispatchEvent(new Event("webln:ready"));
  }, has);
  await peer.page.reload();
  await expect(peer.page.getByTitle("New Chat")).toBeVisible();
}

/** Adds a Testnet Lightning card through the browser wallet (Wallets → New), its panel open. */
export async function connectWebln(peer: Peer): Promise<void> {
  await createWallet(peer, "lightning", "testnet", { provider: "webln", timeout: 30_000, fill: async (form) => {
    await expect(form.getByTestId("webln-found")).toBeVisible();
    await form.getByRole("button", { name: "Connect browser wallet" }).click();
  } });
  await expect(peer.page.getByTestId("lightning-source").getByTestId("lightning-source-status")).toContainText("Connected");
}
