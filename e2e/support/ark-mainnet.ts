import type { BrowserContext } from "@playwright/test";

/**
 * The Mainnet Ark server's answer to /v1/info, as a test server gives it: Mutinynet's (mutinynet.arkade.sh, a public
 * test network), recorded, and made to read as Bitcoin's: `network` is "bitcoin", the forfeit address is the same
 * key's bc1 one, and the delays meet the SDK's Mainnet floors (a checkpoint exit of 169 x 512 s, the Mainnet
 * unilateral exit of 605184 s). Worthless: its keys are a test server's, and nothing is ever paid to it.
 */
export const RECORDED_ARK_INFO = {
  version: "", signerPubkey: "03301078808e4f7bc0dadfe29e34b1df8eaf0108ef06b1722274075ebc107a127a", forfeitPubkey: "02dfcaec558c7e78cf3e38b898ba8a43cfb5727266bae32c5c5b3aeb32c558aa0b",
  forfeitAddress: "bc1qz5zgustrxzztljhfr5pm8s4m0a4v0pzqg7sk5l", checkpointTapscript: "03a90040b27520dfcaec558c7e78cf3e38b898ba8a43cfb5727266bae32c5c5b3aeb32c558aa0bac",
  network: "bitcoin", sessionDuration: "60", unilateralExitDelay: "605184", boardingExitDelay: "604672", utxoMinAmount: "330", utxoMaxAmount: "-1", vtxoMinAmount: "1", vtxoMaxAmount: "-1", dust: "330",
  fees: { intentFee: { offchainInput: "0.0", offchainOutput: "0.0", onchainInput: "0.0", onchainOutput: "0.0" }, txFeeRate: "0" },
  scheduledSession: null, deprecatedSigners: [], serviceStatus: {}, digest: "2e14a884689aba877ecdf423a61862f01b9627927e65cccf119c2aee48fdf4d9", maxTxWeight: "40000", maxOpReturnOutputs: "3",
};

const json = (body: unknown) => ({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });

/**
 * Mainnet Ark without Mainnet: arkade.computer (the server a Mainnet Ark wallet is made with) is answered here and
 * never reached. /v1/info is the recorded answer, the indexer knows nothing of the wallet (no coins, a subscription
 * whose stream never says anything), and anything else is refused. `seen` collects the calls, ids masked. The
 * explorer (mempool.space) is the test's own to route.
 */
export async function mockMainnetArk(context: BrowserContext, seen?: Set<string>): Promise<void> {
  await context.route(/^https:\/\/arkade\.computer\//, async (route) => {
    const url = new URL(route.request().url());
    seen?.add(`${route.request().method()} ${url.pathname.replace(/[0-9a-f]{16,}/g, ":id")}`);
    if (url.pathname === "/v1/info") return route.fulfill(json(RECORDED_ARK_INFO));
    if (url.pathname === "/v1/indexer/vtxos") return route.fulfill(json({ vtxos: [], page: { current: 0, next: 0, total: 0 } }));
    if (url.pathname === "/v1/indexer/script/subscribe") return route.fulfill(json({ subscriptionId: "e2e-mainnet" }));
    if (url.pathname.startsWith("/v1/indexer/script/subscription/")) return new Promise<void>(() => {});
    return route.abort("connectionrefused");
  });
}

/** mempool.space, as an empty explorer that answers at once: no coins at any address, the lowest fees. */
export async function emptyMainnetExplorer(context: BrowserContext): Promise<void> {
  await context.route(/^https:\/\/mempool\.space\//, (route) => route.fulfill(json(/fee/.test(new URL(route.request().url()).pathname) ? { fastestFee: 1, halfHourFee: 1, hourFee: 1, economyFee: 1, minimumFee: 1 } : [])));
}
