import { DIMENSIONS, type Combination } from "./dimensions";

/**
 * What a scenario does, block by block, as data: which blocks apply to a
 * combination, which features of e2e/features.json each one exercises, what
 * infrastructure it needs, and which are not written yet. blocks.ts holds how
 * each block is acted out; this file is what the test map and the report read,
 * so it stays free of Playwright.
 */

export interface Step {
  id: string;
  title: string;
  applies: (c: Combination) => boolean;
  features: (c: Combination) => string[];
  /** Names from requirements.ts. */
  requires: (c: Combination) => string[];
  /** Why this block is not written for this combination yet, if it is not. */
  notYet?: (c: Combination) => string | undefined;
}

const always = () => true;
const none = () => [];
const guest = (c: Combination) => c.client.split("-")[1];

/** Rails with a Testnet payment block in blocks.ts. The others show their Mainnet UI only, for now. */
export const TESTNET_RAILS: readonly Combination["rail"][] = ["cashu", "ln-mint", "ln-webln"];

export const CARD: Record<Combination["rail"], string> = {
  cashu: "cashu", "ln-mint": "lightning", "ln-webln": "lightning", "ln-lnd": "lightning", "ln-cln": "lightning", "ln-nwc": "lightning",
  "ln-breez": "lightning", "ark-arkade": "arkade", bark: "bark", "btc-bdk": "bitcoin", "btc-core": "bitcoin", usdt: "usdt",
};

const RAIL_REQUIREMENT: Partial<Record<Combination["rail"], string>> = {
  cashu: "mint", "ln-mint": "mint", "ln-lnd": "lnd", "ln-cln": "cln", "ln-nwc": "nwc", "ln-breez": "breez",
  "ark-arkade": "ark", bark: "bark", "btc-bdk": "bdk", "btc-core": "bitcoind", usdt: "usdt",
};

const RAIL_FEATURES: Partial<Record<Combination["rail"], string[]>> = {
  cashu: ["wallet.cashu.mint.add", "wallet.cashu.receive-lightning", "payments.cashu.send", "payments.cashu.request", "payments.chat.review", "payments.chat.method-off"],
  "ln-mint": ["wallet.cashu.mint.add", "wallet.cashu.receive-lightning", "wallet.lightning.cashu-mint.pay", "wallet.lightning.cashu-mint.receive"],
  "ln-webln": ["wallet.lightning.webln.connect", "wallet.lightning.webln.pay", "payments.lightning.request", "payments.chat.review", "payments.chat.method-off"],
};

const PROOF_FEATURE: Record<Exclude<Combination["identity"], "none">, string> = {
  nostr: "proofs.nostr", domain: "proofs.domain.dns", ssh: "proofs.ssh", pgp: "proofs.openpgp", bitcoin: "proofs.bitcoin", oidc: "proofs.oidc",
};

const PROOF_TOOL: Partial<Record<Combination["identity"], string>> = { ssh: "ssh-keygen", pgp: "gpg" };

/** In order: what exists before the chat, the chat, how it is delivered, then everything done in it. */
export const PLAN: readonly Step[] = [
  {
    id: "open",
    title: "A and B open Ghostly: B in its language, on its screen",
    applies: always,
    features: (c) => [...(c.locale !== "en" ? ["app.i18n"] : []), ...(c.viewport === "phone" ? [guest(c) === "web" ? "app.mobile-layout" : "app.responsive"] : [])],
    requires: none,
  },
  {
    id: "identity-before",
    title: "what the identity proof needs before the chat exists",
    applies: (c) => c.identity !== "none",
    features: none,
    requires: (c) => (PROOF_TOOL[c.identity] ? [PROOF_TOOL[c.identity]!] : []),
  },
  {
    id: "pair",
    title: "A creates the chat, B joins it with the invite",
    applies: always,
    features: (c) => ["invite.create", "invite.copy", "invite.clipboard", "chat.paired.pair", ...(c.delivery === "dht" ? ["invite.delivery-mode", "invite.dht"] : [])],
    requires: none,
  },
  { id: "talk", title: "messages both ways", applies: always, features: (c) => [c.delivery === "dht" ? "chat.dht.send" : "chat.paired.send"], requires: none },
  {
    id: "delivery",
    title: "B goes away while A writes, and comes back to it",
    applies: always,
    features: (c) => [
      ...({ live: ["chat.paired.offline-send"], dht: ["chat.dht.offline", "chat.paired.send"], "store-forward": ["delivery.hold.enable", "delivery.hold.storage", "delivery.hold.text", "delivery.hold.picture"] })[c.delivery],
      ...(guest(c) === "extension" ? ["app.offline-switch"] : []),
    ],
    requires: (c) => (c.delivery === "store-forward" ? ["s3"] : []),
  },
  {
    id: "transport",
    title: "the transport the pair asked for, and what the clients offer",
    applies: always,
    features: (c) => ["transport.webrtc", ...(c.transport === "webrtc-strict" ? ["transport.switch"] : [])],
    requires: none,
  },
  { id: "files", title: "a file A→B, intact, and a picture B→A", applies: always, features: () => ["files.paired.send", "files.paired.images"], requires: none },
  {
    id: "identity",
    title: "A proves an identity once and shares it; B's app verifies it",
    applies: (c) => c.identity !== "none",
    features: (c) => (c.identity === "none" ? [] : ["proofs.picker", "proofs.binding", PROOF_FEATURE[c.identity], "proofs.share"]),
    requires: (c) => (PROOF_TOOL[c.identity] ? [PROOF_TOOL[c.identity]!] : []),
  },
  {
    id: "payments",
    title: "the rail: a request and a direct send (Testnet), or its Mainnet UI",
    applies: always,
    features: (c) =>
      c.wallet === "mainnet" ? ["wallet.mode", "wallet.deck", "payments.chat.cards"] : ["wallet.mode", ...(RAIL_FEATURES[c.rail] ?? [])],
    requires: (c) => (c.wallet === "testnet" && RAIL_REQUIREMENT[c.rail] ? [RAIL_REQUIREMENT[c.rail]!] : []),
    notYet: (c) => (c.wallet === "testnet" && !TESTNET_RAILS.includes(c.rail) ? `no Testnet payment block for ${c.rail} yet` : undefined),
  },
  {
    id: "group",
    title: "a group: made from contacts (mesh) or joined through its link",
    applies: (c) => c.group !== "none",
    features: (c) => ["groups.create", ...(c.group === "mesh" ? ["groups.invite"] : ["groups.link.enable", "groups.link.join"]), "groups.send"],
    requires: none,
  },
  {
    id: "restore",
    title: "B backs up to a file, restores in a new browser, and goes on talking",
    applies: (c) => c.profile === "restored",
    features: () => ["backup.profile.file", "profiles.switch"],
    requires: none,
  },
];

/** Infrastructure outside the test process: a scenario that needs any is `@gated` in the test map. */
const INFRA = new Set(["mint", "s3", "lnd", "cln", "nwc", "breez", "ark", "bark", "bdk", "bitcoind", "usdt", "desktop"]);

/**
 * The scenario's Playwright tags: the features its blocks exercise (only blocks that are written),
 * the clients it runs, `@gated` when it needs infrastructure, and one `@<dimension>:<value>` per
 * dimension for filtering the HTML report. (The client pair is `@clients:`, since `@client:` is the
 * test map's.)
 */
export function tagsFor(c: Combination): string[] {
  // A Desktop scenario cannot run yet (requirements.ts): it claims nothing.
  const runs = !c.client.startsWith("desktop");
  const steps = runs ? PLAN.filter((s) => s.applies(c) && !s.notYet?.(c)) : [];
  const features = [...new Set(steps.flatMap((s) => s.features(c)))];
  const clients = runs ? [...new Set(c.client.split("-"))] : [];
  const gated = !runs || steps.some((s) => s.requires(c).some((r) => INFRA.has(r)));
  return [
    ...features.map((f) => `@feature:${f}`),
    ...clients.map((client) => `@client:${client}`),
    ...(gated ? ["@gated"] : []),
    ...DIMENSIONS.map((d) => `@${d.id === "client" ? "clients" : d.id}:${c[d.id]}`),
  ];
}
