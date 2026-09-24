import type { WebLNProvider } from "../../packages/browser/src/engine/paymentAdapters/providers/webln";
import { expect, type Peer } from "./fixtures";
import { choose } from "./select";

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

/** Chooses the browser wallet as this mode's Lightning source, on the Lightning card. */
export async function connectWebln(peer: Peer): Promise<void> {
  const source = peer.page.getByTestId("lightning-source");
  await choose(source.getByTestId("lightning-source-select"), "webln");
  await expect(source.getByTestId("webln-found")).toBeVisible();
  await source.getByTestId("provider-form-webln").getByRole("button", { name: "Connect browser wallet" }).click();
  await expect(source.getByTestId("lightning-source-saved")).toBeVisible({ timeout: 30_000 });
  await expect(source.getByTestId("lightning-source-status")).toContainText("Connected");
}
