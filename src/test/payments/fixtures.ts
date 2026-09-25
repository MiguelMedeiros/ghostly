import type { PaymentReview, PaymentTarget } from "@ghostly/core";
import type { EngineApi } from "@ghostly/browser/shared/rpc";
import type { MintView, WalletView } from "@ghostly/browser/shared/types";
import { TEST_MINT } from "@ghostly/browser/shared/mints";
import { servicesPlatform } from "../../lib/platform";

/** The wallets the payment components are shown with: set up and ready unless a test says otherwise. */
export const REAL_MINT = "https://mint.example.com";
export { TEST_MINT };

export const mint = (url: string, balance: number): MintView => ({ url, name: url, balance, info: null });

export const arkReady = (patch: Partial<NonNullable<WalletView["ark"]>> = {}): NonNullable<WalletView["ark"]> =>
  ({ configured: true, locked: false, address: "tark1contact", balance: 5_000, network: "mutinynet", ...patch });
export const barkReady = (patch: Partial<NonNullable<WalletView["bark"]>> = {}): NonNullable<WalletView["bark"]> =>
  ({ configured: true, locked: false, address: "tark1bark", balance: 3_000, network: "signet", ...patch });
export const sparkReady = (patch: Partial<NonNullable<WalletView["spark"]>> = {}): NonNullable<WalletView["spark"]> =>
  ({ configured: true, locked: false, address: "sparkrt1spark", balance: 4_000, network: "regtest", history: [], ...patch });
export const usdtReady = (patch: Partial<NonNullable<WalletView["usdt"]>> = {}): NonNullable<WalletView["usdt"]> =>
  ({ configured: true, locked: false, chainId: 11155111, decimals: 6, balance: "5000000", gasBalance: "0", ...patch });
export const bitcoinSource = (patch: Partial<NonNullable<WalletView["bitcoin"]>> = {}): NonNullable<WalletView["bitcoin"]> =>
  ({ mode: "mainnet", status: "ready", providerId: "bdk", balance: 10_000, network: "signet", history: [], offered: [], ...patch });
export const lightningSource = (patch: Partial<NonNullable<WalletView["lightning"]>> = {}): NonNullable<WalletView["lightning"]> =>
  ({ mode: "mainnet", status: "ready", providerId: "cln-1", recent: [], offered: [], ...patch });

/** A wallet where every card can pay: what the composer's cards are tested against. */
export const everyWallet = (patch: Partial<WalletView> = {}): Partial<WalletView> => ({
  mints: [mint(REAL_MINT, 1_000)],
  balance: 1_000,
  ark: arkReady(),
  bark: barkReady(),
  spark: sparkReady(),
  usdt: usdtReady(),
  bitcoin: bitcoinSource(),
  ...patch,
});

/** How the chat's own wallet is handed to the composer: the web app's, talking to the fake engine. */
export const reviewContext = () => ({ wallet: servicesPlatform!.wallet, peer: "peer", linkId: "link-1" });

/** What the engine answers `preparePayment` with: a review of exactly what was asked. */
export const reviewOf = (params: Parameters<EngineApi["preparePayment"]>[0]): PaymentReview => ({
  ...params.target,
  id: "review-1",
  payee: params.payee,
  linkId: params.linkId,
  requestId: params.requestId,
  memo: params.memo,
  amount: params.amount,
  fee: 1,
  feeCap: params.feeCap,
  createdAt: 0,
  state: "pending",
});

export const target = (patch: Partial<PaymentTarget> = {}): PaymentTarget => ({
  method: "arkade",
  network: "signet",
  provider: "https://ark.example",
  asset: "BTC",
  unit: "sat",
  address: "tark1payee",
  expiresAt: Date.now() + 60_000,
  ...patch,
});

// Invoices. The mainnet one was issued by the public test mint (packages/core/test/bolt11.test.ts); the others are
// BOLT11's "1 cup coffee" example (250,000 sats) under a test network's prefix, checksummed again. Nothing
// here checks signatures, only the bech32 checksum, so they decode as those networks' invoices.
export const MAINNET_INVOICE =
  "lnbc21u1p42mkf2dqqpp56q3d9mfahf0974jqwy0yyfrg7zxksgxk7ufcc084yydhfx43daqqsp59g4z52329g4z52329g4z52329g4z52329g4z52329g4z52329g4q9qrsgqcqzyskhkhqar4dqgqfmarvdttr8x2nrp4txtamfupfftrnn4hmrp7s8ayen7hp2ye58jq8zu65rch9eplpxkhf3pf2nvuynhqxvkw5f7a2vgq486x8x";
export const TESTNET_INVOICE =
  "lntb2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgp702pq0";
export const REGTEST_INVOICE =
  "lnbcrt2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgp9rtqe3";
export const SIGNET_INVOICE =
  "lntbs2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpqh20hy";
