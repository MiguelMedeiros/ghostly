import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, type Locator, type TestInfo } from "@playwright/test";
import { signS3 } from "../../packages/browser/src/backup/s3";
import { testBitcoinWallet } from "../../packages/browser/test/helpers/bitcoinSign";
import { FakeWebln, FakeWeblnLedger } from "../../packages/browser/test/helpers/fakeWebln";
import { fingerprints, TestGpg } from "../../packages/browser/test/helpers/gpg";
import { strangerInvoice } from "../support/bolt11";
import { callTrace, linkTrace, watchCalls, watchLink } from "../support/callTrace";
import { setClipboard } from "../support/clipboard";
import { startTestDomain, type TestDomain } from "../support/domain";
import { delivered, GIF, type WalletKind } from "../support/fixtures";
import { mockMainnetMints } from "../support/mint";
import { closeIdentities, openIdentities, shareIdentity, theirCards, theirFace } from "../support/identities";
import { injectNostrSigner } from "../support/nostrSigner";
import { LocalOidcIssuer } from "../support/oidcIssuer";
import type { LocalRelay } from "../support/relay";
import { testSshKey } from "../support/ssh";
import type { WebLNProvider } from "../../packages/browser/src/engine/paymentAdapters/providers/webln";
import {
  alternatives, cardAction, chatOption, chatPane, composerButton, containing, either, filled, go, home, newWallet, newWalletDialog, nickname, openChat, paymentCard, reloaded, say, sees, setLanguage, wallet, type Actor,
} from "./actors";
import type { Combination } from "./dimensions";
import { CARD, type Step } from "./plan";
import { approve, bubble, chatMethods, INFRA_RAILS, memo } from "./rails";
import { unmet } from "./requirements";
import { choose, optionsOf, close } from "../support/select";

/**
 * The building blocks a scenario is made of. Each one does one thing a person
 * does (pair, talk, send a file, share a proof, pay, go away, restore) for any
 * client, language and screen, asserts what the other person should see, and
 * names the features it exercises (the ids of e2e/features.json).
 *
 * A block whose infrastructure is not up is skipped with the reason and noted
 * on the test (`skipped-block`); the scenario goes on with the next one.
 */

export interface World {
  combo: Combination;
  a: Actor;
  b: Actor;
  relay: LocalRelay;
  info: TestInfo;
  /** Opens one more person (a group's third member, a restored profile), of the given kind. */
  open(kind: Actor["kind"], name: string, options?: { phone?: boolean }): Promise<Actor>;
  /** Run at the end, whatever happens. */
  cleanup: (() => Promise<void> | void)[];
  /** Filled by the identity block's preparation. */
  identity?: IdentityKit;
}

/** How one step of the plan (plan.ts: what it covers, what it needs) is acted out. */
export interface Block {
  id: string;
  run: (w: World) => Promise<void>;
}

/* ---------- the chat itself ---------- */

async function copyInvite(actor: Actor): Promise<string> {
  // The app writes the invite to the clipboard; the test's clipboard keeps it in the page instead.
  await actor.page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (value: string) => { (window as unknown as { qaInvite: string }).qaInvite = value; } },
    });
  });
  await actor.page.getByTestId("invite-card").getByRole("button", { name: either("Copy invite") }).click();
  return actor.page.evaluate(() => (window as unknown as { qaInvite: string }).qaInvite);
}

async function joinWith(actor: Actor, text: string): Promise<void> {
  await actor.page.getByRole("button", { name: either("Join chat") }).first().click();
  await setClipboard(actor.page, text);
  await actor.page.getByRole("button", { name: either("Paste from clipboard") }).click();
}

const connected = (actor: Actor, transport = "WebRTC", timeout = 180_000) =>
  expect(actor.page.getByTestId("connection-options")).toHaveAttribute("aria-label", new RegExp(`${alternatives("Connected")} · ${transport}`), { timeout });
/**
 * Leaving DHT-only after the contact reloaded once took 70 s, and once more than 3 minutes, to find
 * WebRTC again. It takes seconds now (6–14 s from the first switch, measured by e2e/web/dht-back-timing.spec.ts):
 * a wait long enough to hide the old behaviour again would not catch it.
 */
const LIVE_AGAIN_MS = 45_000;

const hashOf = (actor: Actor) => actor.page.evaluate(() => location.hash);

export const pair: Block = {
  id: "pair",
  run: async ({ a, b, combo }) => {
    await a.page.getByTitle(either("New Chat")).click();
    if (combo.delivery === "dht") {
      // DHT only is chosen in the chat's Connection menu (WISP 400), not in its invite.
      await dhtOnly(a, true);
      await expect.poll(() => copyInvite(a)).toMatch(/^https:\/\/ghostly\.tools\/#ghostly1p/);
    }
    const invite = await copyInvite(a);
    await joinWith(b, invite);
    for (const p of [a, b]) {
      await expect(p.page.getByPlaceholder(either("Message…"))).toBeEnabled({ timeout: 90_000 });
      p.chatHash = await hashOf(p);
    }
    expect(a.chatHash).toMatch(/^#\/chat\//);
  },
};

/**
 * A DHT chat carries one text awaiting its receipt at a time (packages/core/src/dhtDelivery.ts):
 * the next one waits for it, as a person would be told to.
 */
const receipted = (actor: Actor) =>
  expect(chatPane(actor).locator('[data-testid="message-delivery"][data-delivery="sent"]')).toHaveCount(0, { timeout: 120_000 });

export const talk: Block = {
  id: "talk",
  run: async ({ a, b, combo }) => {
    await say(b, `boo from ${b.name} 👻`);
    await sees(a, `boo from ${b.name} 👻`);
    if (combo.delivery === "dht") await receipted(b);
    await say(a, `olá from ${a.name}`);
    await sees(b, `olá from ${a.name}`);
    if (combo.delivery === "dht") await receipted(a);
    if (combo.delivery !== "dht") for (const p of [a, b]) await connected(p);
  },
};

/* ---------- delivery: away and back ---------- */

/**
 * B leaves, and later comes back to the chat. A web page is closed (its peer goes with it); the
 * extension's peer lives in its offscreen document whatever its pages do, so it goes away through
 * Ghostly's own Offline switch instead.
 */
async function away(actor: Actor): Promise<() => Promise<void>> {
  if (actor.kind === "extension") {
    await setOnline(actor, false);
    return async () => { await setOnline(actor, true); await openChat(actor); };
  }
  const url = actor.page.url();
  await actor.page.close();
  return async () => {
    actor.page = await actor.context.newPage();
    await actor.page.goto(url);
    await expect(chatPane(actor)).toBeVisible({ timeout: 60_000 });
  };
}

async function setOnline(actor: Actor, online: boolean): Promise<void> {
  await go(actor, "#/services");
  const toggle = actor.page.getByTestId("online-toggle");
  const want = online ? /Online/ : /Offline/;
  if (!want.test((await toggle.textContent()) ?? "")) await toggle.click();
  await expect(toggle).toHaveText(want);
}

/** DHT only is one of the connection choices; off leaves it for Automatic (a browser's one transport). */
async function dhtOnly(actor: Actor, on: boolean): Promise<void> {
  const menu = actor.page.getByTestId("connection-menu");
  if ((await menu.getAttribute("open")) === null) await actor.page.getByTestId("connection-options").click();
  const panel = actor.page.getByRole("dialog", { name: either("Connection options") });
  const choice = panel.getByRole("radio", { name: either("DHT only") });
  const back = panel.getByRole("radio", { name: either("Automatic") }).or(panel.getByRole("radio", { name: "WebRTC", exact: true })).first();
  if ((await choice.isChecked()) !== on) await (on ? choice : back).click();
  await expect.poll(() => choice.isChecked()).toBe(on);
  await actor.page.keyboard.press("Escape");
}

const S3_BUCKET = `ghostly-matrix-${Date.now()}-${randomBytes(3).toString("hex")}`;
const s3 = () => ({
  endpoint: process.env.GHOSTLY_S3_ENDPOINT ?? "",
  credentials: { region: "us-east-1", accessKeyId: process.env.GHOSTLY_S3_KEY ?? "", secretAccessKey: process.env.GHOSTLY_S3_SECRET ?? "" },
});
let bucketMade: Promise<void> | undefined;
async function bucket(): Promise<string> {
  bucketMade ??= (async () => {
    const { endpoint, credentials } = s3();
    const url = new URL(`${endpoint}/${S3_BUCKET}`);
    const response = await fetch(url, { method: "PUT", headers: await signS3({ method: "PUT", url }, credentials) });
    if (!response.ok && response.status !== 409) throw new Error(`test bucket: ${response.status}`);
  })();
  await bucketMade;
  return S3_BUCKET;
}

export const delivery: Block = {
  id: "delivery",
  run: async ({ a, b, combo, info }) => {
    if (combo.delivery === "dht") {
      // From here on, for the step back to live below: what each side's link and relay requests did.
      for (const p of [a, b]) await watchLink(p).catch(() => {});
      const back = await away(b);
      await say(a, "waiting in the DHT mailbox");
      await expect(chatPane(a).locator('[data-testid="message-delivery"][data-delivery="sent"]').last()).toBeVisible();
      await back();
      // A web page away was closed: its reopened page is watched from now.
      await watchLink(b).catch(() => {});
      await sees(b, "waiting in the DHT mailbox");
      await expect(chatPane(a).locator('[data-testid="message-delivery"][data-delivery="delivered"]').first()).toBeVisible({ timeout: 90_000 });
      // The rest of the story needs a live link: files, payments, groups.
      const left: string[] = [];
      await dhtOnly(b, false);
      left.push(`${new Date().toISOString()} ${b.name} left DHT only`);
      await dhtOnly(a, false);
      left.push(`${new Date().toISOString()} ${a.name} left DHT only`);
      try {
        for (const p of [a, b]) await connected(p, "WebRTC", LIVE_AGAIN_MS);
      } catch (error) {
        // "On DHT · retrying live" tells nothing of why: what each side's link did does.
        for (const p of [a, b]) {
          const trace = await linkTrace(p).catch((e) => `(no trace: ${e})`);
          await info.attach(`${p.name}'s chat link`, { body: `${left.join("\n")}\n${trace}`, contentType: "text/plain" });
        }
        throw error;
      }
      await say(b, "live again");
      await sees(a, "live again");
      return;
    }
    if (combo.delivery === "store-forward") {
      const { endpoint, credentials } = s3();
      await go(a, "#/profile");
      const backups = a.page.getByTestId("profile-backups");
      await backups.getByTestId("s3-setup").click();
      await backups.getByTestId("s3-endpoint").fill(endpoint);
      await backups.getByTestId("s3-bucket").fill(await bucket());
      await backups.getByTestId("s3-accessKeyId").fill(credentials.accessKeyId);
      await backups.getByTestId("s3-secretAccessKey").fill(credentials.secretAccessKey);
      await backups.getByTestId("s3-save").click();
      await expect(backups.getByTestId("backup-done")).toContainText("Connected", { timeout: 30_000 });
      for (const p of [a, b]) {
        await openChat(p);
        await chatOption(p, "chat-hold-open");
        const dialog = p.page.getByTestId("chat-hold");
        await dialog.getByTestId("chat-hold-toggle").click();
        await dialog.getByTestId("chat-hold-save").click();
        await expect(dialog).toHaveCount(0);
      }
      await expect(async () => {
        await chatOption(a, "chat-hold-open");
        await expect(a.page.getByTestId("chat-hold").getByTestId("chat-hold-contact")).toHaveText("Contact: allows it");
        await a.page.keyboard.press("Escape");
      }).toPass({ timeout: 60_000 });
      const back = await away(b);
      await expect(a.page.getByTestId("connection-options")).toHaveAttribute("data-status", "Away · messages are held", { timeout: 60_000 });
      // Past the 256 bytes the DHT carries: a short text would take the DHT floor (WISP 403); a longer one is held.
      const held = `held in my S3 for you ${"and more words past what the DHT carries. ".repeat(7)}`;
      await say(a, held);
      await a.page.getByTestId("file-input").setInputFiles({ name: "held.gif", mimeType: "image/gif", buffer: GIF });
      // The bubble says nothing of it (#360): its mark is the clock, held for B.
      await expect(delivered(chatPane(a).locator(".group").filter({ hasText: "held in my S3 for you" }), "held")).toBeVisible({ timeout: 60_000 });
      await back();
      await sees(b, held.trim());
      await expect(chatPane(b).getByTestId("file-bubble").filter({ hasText: "held.gif" })).toBeVisible({ timeout: 90_000 });
      await expect(a.page.getByTestId("hold-indicator")).toHaveCount(0, { timeout: 90_000 });
      return;
    }
    // Live: the stream goes when B does; what A writes meanwhile is waiting for B.
    const back = await away(b);
    await expect(a.page.getByTestId("connection-options")).not.toHaveAttribute("aria-label", /Connected · WebRTC/, { timeout: 90_000 });
    await say(a, "are you there?");
    await back();
    await sees(b, "are you there?");
    for (const p of [a, b]) await connected(p);
  },
};

/* ---------- transport ---------- */

export const transport: Block = {
  id: "transport",
  run: async ({ a, b, combo }) => {
    for (const p of [a, b]) {
      await openChat(p);
      await p.page.getByTestId("connection-options").click();
      const dialog = p.page.getByRole("dialog", { name: either("Connection options") });
      // A browser has WebRTC only: the native transports are there, and refused.
      await expect(dialog.getByRole("radio", { name: "WebRTC", exact: true })).toBeEnabled();
      await expect(dialog.getByRole("radio", { name: "WebRTC", exact: true })).toBeChecked();
      for (const native of ["Iroh", "HyperDHT"]) await expect(dialog.getByRole("radio", { name: native, exact: true })).toBeDisabled();
      if (combo.transport === "webrtc-strict") {
        const fallback = dialog.getByRole("switch", { name: either("Fallback") });
        await fallback.click();
        await expect(fallback).not.toBeChecked();
      }
      await p.page.keyboard.press("Escape");
    }
    for (const p of [a, b]) await connected(p);
    await say(a, `over ${combo.transport}`);
    await sees(b, `over ${combo.transport}`);
    for (const p of [a, b]) await connected(p);
  },
};

/* ---------- calls ---------- */

/** The chat calls over its live session (`calls/1`): A rings, B answers, the call connects, A hangs up. */
export const calls: Block = {
  id: "calls",
  run: async ({ a, b, info }) => {
    for (const p of [a, b]) {
      await openChat(p);
      await expect(p.page.getByTestId("call-audio")).toBeEnabled({ timeout: LIVE_AGAIN_MS });
    }
    for (const p of [a, b]) await watchCalls(p.page);
    await a.page.getByTestId("call-audio").click();
    await b.page.getByTitle(either("Accept audio call")).click();
    try {
      for (const p of [a, b]) await expect(p.page.getByTestId("call-window").getByText(/^\d{1,2}:\d{2}$/)).toBeVisible();
    } catch (error) {
      // Two windows saying "Connecting..." tell nothing of why: what each side's connection did does.
      for (const p of [a, b]) {
        const trace = await callTrace(p.page).catch((e) => `(no trace: ${e})`);
        await info.attach(`${p.name}'s call connections`, { body: trace, contentType: "text/plain" });
      }
      throw error;
    }
    await a.page.getByTitle("End call").click();
    for (const p of [a, b]) await expect(p.page.getByTestId("call-window")).toHaveCount(0);
  },
};

/* ---------- files ---------- */

export const files: Block = {
  id: "files",
  run: async ({ a, b }) => {
    const bytes = randomBytes(200 * 1024 + 13);
    const input = a.page.getByTestId("file-input");
    await input.setInputFiles({ name: "matrix.bin", mimeType: "application/octet-stream", buffer: bytes });
    const save = chatPane(b).getByTestId("file-bubble").filter({ hasText: "matrix.bin" }).last().getByTestId("file-save");
    await expect(save).toBeVisible({ timeout: 90_000 });
    const downloading = b.page.waitForEvent("download");
    await save.click();
    const saved = await downloading;
    expect(createHash("sha256").update(readFileSync((await saved.path())!)).digest("hex")).toBe(createHash("sha256").update(bytes).digest("hex"));
    await b.page.getByTestId("file-input").setInputFiles({ name: "ghost.gif", mimeType: "image/gif", buffer: GIF });
    await expect(chatPane(a).getByTestId("file-bubble").filter({ hasText: "ghost.gif" }).getByRole("img", { name: "ghost.gif" })).toBeVisible({ timeout: 90_000 });
  },
};

/* ---------- identity proofs ---------- */

interface IdentityKit {
  /** Anything to do before the chat exists (a signer injected in the page reloads it). */
  before?: () => Promise<void>;
  /** Profile → Identities → the kind, up to a saved proof. */
  add: () => Promise<void>;
  /** What B's app says about who attests it. */
  seen?: RegExp;
}

function identityKit(w: World): IdentityKit | undefined {
  const { a, b } = w;
  const start = async (tile: string) => {
    await go(a, "#/identities");
    await a.page.getByTestId("identities-new").click();
    const add = a.page.getByTestId("add-identity");
    await add.getByTestId(tile).click();
    return add;
  };
  const saved = async () => {
    await expect(a.page.getByTestId("add-identity")).toHaveCount(0);
    await expect(a.page.getByTestId("identity-proof")).toHaveCount(1);
  };
  switch (w.combo.identity) {
    case "none":
      return undefined;
    case "nostr":
      return {
        before: async () => { await injectNostrSigner(a); },
        add: async () => {
          const add = await start("add-identity-nostr");
          await expect(add.getByTestId("add-identity-signer")).toHaveAttribute("data-value", "nip07");
          await add.getByTestId("add-identity-start").click();
          await saved();
        },
      };
    case "domain": {
      let site: TestDomain | undefined;
      return {
        before: async () => {
          // Two ports per worker: the ephemeral environment's slots, or the matrix's own range.
          site = await startTestDomain(w.info.parallelIndex % 40, Number(process.env.E2E_DOMAIN_PORT || 47320));
          w.cleanup.push(() => site?.close());
          for (const p of [a, b]) await site.attach(p.context);
        },
        add: async () => {
          const add = await start("add-identity-domain");
          await choose(add.getByTestId("add-identity-signer"), "dns");
          await add.getByTestId("add-identity-subject").fill(site!.domain);
          await add.getByTestId("add-identity-start").click();
          site!.publishTxt((await add.getByTestId("add-identity-copy-1").textContent())!);
          await add.getByTestId("add-identity-finish").click();
          await saved();
        },
      };
    }
    case "ssh": {
      const key = testSshKey();
      w.cleanup.push(() => key.dispose());
      return {
        add: async () => {
          const add = await start("add-identity-ssh");
          await add.getByTestId("add-identity-subject").fill(key.publicKey);
          await add.getByTestId("add-identity-start").click();
          const statement = (await add.getByTestId("add-identity-copy-1").textContent())!;
          await add.getByTestId("add-identity-paste").fill(key.sign(statement));
          await add.getByTestId("add-identity-finish").click();
          await saved();
        },
      };
    }
    case "pgp": {
      const gpg = new TestGpg(["alice"]);
      w.cleanup.push(() => gpg.close());
      return {
        add: async () => {
          const add = await start("add-identity-openpgp");
          await add.getByTestId("add-identity-subject").fill(fingerprints.alice);
          await add.getByTestId("add-identity-start").click();
          const statement = (await add.getByTestId("add-identity-copy-2").textContent())!;
          await add.getByTestId("add-identity-paste").fill(`${gpg.clearsign(fingerprints.alice, statement)}\n${gpg.exportKey(fingerprints.alice)}`);
          await add.getByTestId("add-identity-finish").click();
          await saved();
        },
      };
    }
    case "bitcoin": {
      const key = testBitcoinWallet("p2wpkh");
      return {
        add: async () => {
          const add = await start("add-identity-bitcoin");
          await add.getByTestId("add-identity-subject").fill(key.address);
          await choose(add.getByTestId("add-identity-signer"), "sparrow");
          await add.getByTestId("add-identity-start").click();
          const statement = (await add.getByTestId("add-identity-copy-0").textContent())!.trim();
          await add.getByTestId("add-identity-paste").fill(key.signBip322(statement).simple!);
          await add.getByTestId("add-identity-finish").click();
          await saved();
        },
      };
    }
    case "oidc": {
      const issuer = new LocalOidcIssuer();
      return {
        before: async () => { for (const p of [a, b]) await issuer.attach(p.context); },
        add: async () => {
          const add = await start("add-identity-oidc");
          await choose(add.getByTestId("add-identity-signer"), "oidc-email");
          await add.getByTestId("add-identity-start").click();
          const [popup] = await Promise.all([a.context.waitForEvent("page"), add.getByTestId("add-identity-finish").click()]);
          await popup.getByRole("link", { name: "Continue as alice" }).click();
          await saved();
        },
        seen: /oidc\.ghostly\.test/,
      };
    }
  }
}

export const identityBefore: Block = {
  id: "identity-before",
  run: async (w) => {
    w.identity = identityKit(w);
    await w.identity?.before?.();
  },
};

export const identity: Block = {
  id: "identity",
  run: async (w) => {
    const { a, b } = w;
    if (!w.identity) return;
    await w.identity.add();
    await openChat(a);
    await shareIdentity(a, undefined, { timeout: 90_000 });
    await closeIdentities(a);
    await openChat(b);
    await expect(b.page.getByTestId("chat-identity-badge").first()).toBeVisible({ timeout: 60_000 });
    await openIdentities(b);
    const received = theirCards(b);
    await expect(received).toHaveCount(1);
    await expect(theirFace(b)).toHaveAttribute("data-status", "verified");
    if (w.identity.seen) await expect(received).toContainText(w.identity.seen);
    await closeIdentities(b);
  },
};

/* ---------- wallet ---------- */


/**
 * With a mint of our own, every peer adds it to its Testnet Cashu wallet and makes it primary: the extension's engine
 * cannot be rerouted to it.
 */
async function localMint(actor: Actor): Promise<void> {
  const url = process.env.E2E_MINT_URL;
  if (!url) return;
  await wallet(actor, "cashu-testnet");
  await actor.page.getByTestId("wallet-mint-url").fill(url);
  await actor.page.getByTestId("wallet-add-mint").click();
  await expect(actor.page.getByTestId("wallet-mint-url")).toHaveValue("");
  await actor.page.getByTestId("mint-row").filter({ hasText: new URL(url).host }).getByRole("button", { name: either("Make primary") }).click();
}

/** Test sats from Get test coins: the wallet's first test mint (the local one, primary) pays its own faucet invoice. */
async function getTestCoins(actor: Actor): Promise<void> {
  await wallet(actor, "cashu");
  await actor.page.getByTestId("test-coins-get").click();
  await expect(actor.page.getByTestId("test-coins-result")).toBeVisible({ timeout: 60_000 });
}

async function cashuInChat({ a, b }: World): Promise<void> {
  for (const p of [a, b]) await localMint(p);
  await getTestCoins(a);
  // A direct send: reviewed, approved, received.
  await openChat(a);
  await paymentCard(a, "cashu");
  await a.page.getByTestId("payment-amount").fill("21");
  await memo(a, "matrix send");
  await cardAction(a, "send");
  await approve(a.page.getByTestId("payment-composer"));
  await openChat(b);
  await expect(bubble(b, "matrix send").getByTestId("payment-state")).toHaveText(either("Received"), { timeout: 90_000 });
  // The sheet closed once the payment went out.
  await expect(a.page.getByTestId("payment-composer")).toHaveCount(0);
  // A request: B asks, A pays from the bubble.
  await chatMethods(b, ["lightning"]);
  await paymentCard(b, "cashu");
  await b.page.getByTestId("payment-amount").fill("10");
  await memo(b, "matrix request");
  await cardAction(b, "request");
  await openChat(a);
  const request = bubble(a, "matrix request");
  await request.getByTestId("payment-pay").click();
  await approve(request);
  await expect(request.getByTestId("payment-state")).toHaveText(either("Paid"), { timeout: 90_000 });
  await expect(bubble(b, "matrix request").getByTestId("payment-state")).toHaveText(either("Paid"), { timeout: 90_000 });
}

async function lightningThroughMint({ a, b }: World): Promise<void> {
  for (const p of [a, b]) await localMint(p);
  await getTestCoins(a);
  // Out: an invoice the mint does not own, so the melt is real. A test chain's: a Testnet wallet pays a Bitcoin (lnbc)
  // invoice only through the public test mint, and the local mint here is not it.
  await wallet(a, "lightning");
  await a.page.getByTestId("wallet-send").click();
  await a.page.getByTestId("wallet-pay-input").fill(strangerInvoice(25, "ghostly e2e", "lntb"));
  await a.page.getByRole("button", { name: filled("Pay {{amount}} {{unit}}", { amount: "25", unit: alternatives("test sats") }) }).click();
  await a.page.getByRole("button", { name: either("Pay") }).click();
  await expect(a.page.getByTestId("wallet-notice")).toHaveText(either("Paid."), { timeout: 60_000 });
  // In, on B's side: an invoice of B's own wallet. The test mint reads it paid by itself, which is nobody paying:
  // Receive only makes the invoice, and nothing arrives.
  await wallet(b, "lightning");
  await b.page.getByTestId("wallet-receive").click();
  await b.page.getByTestId("wallet-receive-amount").fill("25");
  await b.page.getByTestId("wallet-create-invoice").click();
  await expect(b.page.getByTestId("wallet-invoice")).toBeVisible({ timeout: 60_000 });
  await b.page.waitForTimeout(10_000);
  await expect(b.page.getByTestId("wallet-paid")).toHaveCount(0);
  // In a chat, Lightning only pays a request: a direct send is refused with the reason.
  await openChat(a);
  await paymentCard(a, "lightning");
  await expect(a.page.getByTestId("payment-send")).toBeDisabled();
  await a.page.keyboard.press("Escape");
}

/** support/webln.ts's installWebln, waiting for the app in either language. */
async function installWebln(actor: Actor, source: WebLNProvider): Promise<void> {
  const methods = (["enable", "getInfo", "makeInvoice", "sendPayment", "getBalance", "lookupInvoice"] as const).filter((m) => typeof source[m] === "function");
  await actor.context.exposeBinding("__ghostlyWebln", async (_caller, method: (typeof methods)[number], args: unknown[]) =>
    (source[method] as (...a: unknown[]) => Promise<unknown>).apply(source, args));
  await actor.context.addInitScript((names: readonly string[]) => {
    const page = window as unknown as { webln: unknown; __ghostlyWebln(method: string, args: unknown[]): Promise<unknown> };
    page.webln = Object.fromEntries(names.map((m) => [m, (...args: unknown[]) => page.__ghostlyWebln(m, args)]));
    window.dispatchEvent(new Event("webln:ready"));
  }, methods);
  await reloaded(actor);
}

async function lightningThroughWebln(w: World): Promise<void> {
  const { a, b } = w;
  const ledger = new FakeWeblnLedger();
  const aliceWallet = new FakeWebln(ledger, { alias: "A's wallet" }), bobWallet = new FakeWebln(ledger, { alias: "B's wallet" });
  for (const [p, source] of [[a, aliceWallet], [b, bobWallet]] as const) {
    await installWebln(p, source);
    // A Testnet Lightning wallet through the browser wallet, made with New. It is the person's one wallet, so a
    // request carries its invoice alone.
    await newWallet(p, "lightning", "testnet", { provider: "webln", timeout: 30_000, fill: async (form) => {
      await expect(form.getByTestId("webln-found")).toBeVisible();
      await form.getByTestId("provider-form-webln").getByRole("button", { name: either("Connect browser wallet") }).click();
    } });
    await wallet(p, "lightning-testnet");
    await expect(p.page.getByTestId("lightning-source").getByTestId("lightning-source-status")).toContainText(containing("Connected"));
  }
  // Both pages were reloaded for the browser wallet: the chat is live again before B asks. A request made before that
  // goes by what A allowed at the last session, when A had no wallet yet ("Cashu and Lightning are off in this chat").
  for (const p of [a, b]) { await openChat(p); await connected(p); }
  await openChat(b);
  await paymentCard(b, "lightning-testnet");
  await b.page.getByTestId("payment-amount").fill("40");
  await memo(b, "matrix lightning request");
  await cardAction(b, "request");
  await openChat(a);
  const request = bubble(a, "matrix lightning request");
  await request.getByTestId("payment-pay").click();
  await approve(request);
  await expect(request.getByTestId("payment-state")).toHaveText(either("Paid"), { timeout: 90_000 });
  await openChat(b);
  await expect(bubble(b, "matrix lightning request").getByTestId("payment-state")).toHaveText(either("Paid"), { timeout: 90_000 });
  expect([aliceWallet.balance, bobWallet.balance]).toEqual([99_960, 100_040]);
}

export const TESTNET: Partial<Record<Combination["rail"], (w: World) => Promise<void>>> = {
  cashu: cashuInChat,
  "ln-mint": lightningThroughMint,
  "ln-webln": lightningThroughWebln,
  ...INFRA_RAILS,
};

/**
 * The Testnet wallets a rail's block pays with, made with New before it runs. A rail through a source of its own
 * (a node, a browser wallet, Breez, BDK) makes its wallet in its block, through the source's form in New.
 */
const TESTNET_WALLETS: Partial<Record<Combination["rail"], WalletKind[]>> = {
  cashu: ["cashu"], "ln-mint": ["cashu"], "ark-arkade": ["arkade"], bark: ["bark"], usdt: ["usdt"],
};

/** What Mainnet's New says of a kind: `Not yet` (with its reason), or what clicking it does (`Create`, `Connect…`). */
const offer = (dialog: Locator, kind: WalletKind) => dialog.getByTestId(`new-wallet-type-${kind}-status`);

/**
 * Mainnet: nothing moves, and no real mint, node or chain is reached. A web person makes a Mainnet Cashu wallet (and
 * the Lightning through it) against the suite's own mint (support/mint.ts `mockMainnetMints`); the extension's
 * offscreen engine cannot be rerouted, so there, as for every rail whose Mainnet needs a real server or is not there
 * yet, what New offers on Mainnet is what is checked. The chat offers what was made, and nothing else.
 */
async function mainnetUi({ a, b, combo }: World): Promise<void> {
  const card = CARD[combo.rail];
  const made = new Set<Actor>();
  for (const p of [a, b]) {
    await wallet(p);
    // No network switch: each wallet has its own network.
    await expect(p.page.getByTestId("wallet-mode")).toHaveCount(0);
    if ((combo.rail === "cashu" || combo.rail === "ln-mint") && p.kind === "web") {
      await mockMainnetMints(p.context);
      await newWallet(p, "cashu", "mainnet");
      await expect(p.page.getByTestId("wallet-card-cashu-mainnet").getByTestId("wallet-card-network")).toHaveCount(0);
      if (combo.rail === "ln-mint") {
        await wallet(p, "lightning-mainnet");
        await expect(p.page.getByTestId("wallet-card-lightning-mainnet")).toContainText(containing("Invoices via Cashu"));
        await expect(p.page.getByTestId("lightning-source").getByTestId("lightning-source-current")).toContainText("Cashu mints");
      }
      made.add(p);
      continue;
    }
    const dialog = await newWalletDialog(p, "mainnet");
    if (combo.rail === "cashu" || combo.rail === "ln-mint") await expect(offer(dialog, "cashu")).toHaveText(either("Create"));
    else if (card === "bitcoin") {
      // No on-chain source runs in a browser on Mainnet (BDK is Testnet only; Bitcoin Core is Desktop only).
      await expect(offer(dialog, "bitcoin")).toHaveText(either("Not yet"));
    } else if (card === "lightning") {
      // Only the sources Mainnet allows are offered; the test sources never are.
      await expect(offer(dialog, "lightning")).toHaveText(either("Connect…"));
      await dialog.getByTestId("new-wallet-type-lightning").click();
      const select = dialog.getByTestId("new-wallet-provider-select");
      const options = (await select.count()) ? await (await optionsOf(select)).allTextContents() : [await dialog.getByTestId("new-wallet-provider").innerText()];
      if (await select.count()) await close(select);
      expect(options.join(" ")).not.toMatch(/fake|regtest|\(test\)/i);
    } else {
      // Ark, Bark (#305) and USDT: one click on Mainnet, but that reaches the real server and chain, so it is not made here.
      await expect(offer(dialog, card as WalletKind)).toHaveText(either("Create"));
    }
    await p.page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  }
  // Each chat tells its contact which networks its wallets are on.
  await openChat(b);
  await openChat(a);
  const button = await composerButton(a, "payment-button");
  await expect(button).toBeEnabled({ timeout: 60_000 });
  await button.click();
  const composer = a.page.getByTestId("payment-composer");
  if (made.has(a)) {
    // The Mainnet card of what was made; the card meets B's wallet of that network when B has one.
    const shown = composer.getByTestId(`payment-card-${card}-mainnet`);
    await expect(shown).toBeVisible();
    await expect(composer.locator("[data-testid^=payment-card-][data-testid$=-testnet]")).toHaveCount(0);
    // A contact with no wallet at all says so ("Your contact has no wallet yet"); one with wallets elsewhere, which network.
    const noWallet = /Your contact has no (?:Mainnet|wallet yet)/;
    if (made.has(b)) await expect(shown).not.toHaveAttribute("title", noWallet, { timeout: 60_000 });
    else await expect(shown).toHaveAttribute("title", noWallet, { timeout: 60_000 });
  } else {
    // No wallet: no card, and the composer says how to make one.
    await expect(composer.getByTestId("payment-no-wallet")).toBeVisible();
    await expect(composer.locator("[data-testid^=payment-card-]")).toHaveCount(0);
  }
  await a.page.keyboard.press("Escape");
}

export const payments: Block = {
  id: "payments",
  run: async (w) => {
    if (w.combo.wallet === "mainnet") return mainnetUi(w);
    // Setting a source up, funding it and paying four times on a chain takes minutes of its own. Arkade's coins
    // outlive their regtest batch on the way, and each recovery waits for the server's sweep (rails.ts).
    w.info.setTimeout(w.info.timeout + (w.combo.rail === "ark-arkade" ? 20 : 10) * 60_000);
    // A new profile has no wallet: each person makes the rail's Testnet wallets with New.
    for (const p of [w.a, w.b]) for (const kind of TESTNET_WALLETS[w.combo.rail] ?? []) await newWallet(p, kind, "testnet");
    await TESTNET[w.combo.rail]!(w);
  },
};

/* ---------- groups ---------- */

export const group: Block = {
  id: "group",
  run: async (w) => {
    const { a, b, combo } = w;
    const name = `Matrix ${w.info.testId.slice(0, 6)}`;
    await home(a);
    await a.page.getByTestId("sidebar-new-more").click();
    await a.page.getByTestId("new-group").click();
    await a.page.getByTestId("new-group-name").fill(name);
    // A private group (group-mesh/1): its `group1` link and contact invitations are what this block walks.
    await a.page.getByTestId("new-group-kind-mesh").click();
    await a.page.getByTestId("new-group-create").click();
    // A new group opens on its link, already on.
    const share = a.page.getByTestId("group-share-dialog");
    await expect(share.getByTestId("group-link-url")).toHaveValue(/#\/join\/group1\//);
    const url = await share.getByTestId("group-link-url").inputValue();
    await share.getByTestId("group-share-done").click();
    await expect(a.page.getByTestId("group-name")).toHaveText(name);
    const members = [b];
    if (combo.group === "link") {
      await home(b);
      await joinWith(b, url);
    } else {
      // Carol knows only Alice: the group is what introduces her to Bob.
      const c = await w.open("web", "carol");
      await nickname(c, "Carol");
      await home(a);
      await a.page.getByTitle(either("New Chat")).click();
      // The group's edges need a live link: a new chat is never DHT only unless someone chooses it.
      await joinWith(c, await copyInvite(a));
      await expect(c.page.getByPlaceholder(either("Message…"))).toBeEnabled({ timeout: 90_000 });
      await go(a, "#/");
      await a.page.getByTestId("group-row").filter({ hasText: name }).click();
      for (const [who, nick] of [[b, "Bob"], [c, "Carol"]] as const) {
        await a.page.getByTestId("group-members").click();
        const row = a.page.getByTestId("group-invite-contact").filter({ hasText: nick });
        await expect(row.getByTestId("group-invite")).toBeEnabled({ timeout: 60_000 });
        await row.getByTestId("group-invite").click();
        await a.page.keyboard.press("Escape");
        await home(who);
        const invited = who.page.getByTestId("group-row").filter({ hasText: name });
        await invited.getByTestId("group-accept").click();
        await expect(invited).toContainText(/\d+/, { timeout: 60_000 });
        await invited.click();
      }
      members.push(c);
    }
    for (const m of members) await expect(m.page.getByTestId("group-chat")).toHaveAttribute("data-status", "active", { timeout: 120_000 });
    await say(a, "hello, group");
    for (const m of members) await sees(m, "hello, group", 120_000);
    await say(b, "hi from Bob in the group");
    await sees(a, "hi from Bob in the group", 120_000);
    if (members.length > 1) await sees(members[1], "hi from Bob in the group", 120_000);
  },
};

/* ---------- profile ---------- */

const PASSPHRASE = "matrix backup passphrase";

export const restore: Block = {
  id: "restore",
  run: async (w) => {
    const { a } = w;
    const b = w.b;
    await go(b, "#/profile");
    const backups = b.page.getByTestId("profile-backups");
    await backups.getByTestId("backup-open").click();
    await backups.getByTestId("backup-passphrase").fill(PASSPHRASE);
    await backups.getByTestId("backup-confirm").fill(PASSPHRASE);
    const downloading = b.page.waitForEvent("download");
    await backups.getByTestId("backup-download").click();
    const file = await downloading;
    const bundle = readFileSync((await file.path())!);
    // The old browser is gone: two apps with one key would be a different story.
    await b.context.close();

    const restored = await w.open(b.kind, `${b.name}-restored`, { phone: b.phone });
    if (b.locale !== "en") await setLanguage(restored, b.locale);
    await go(restored, "#/profile");
    const again = restored.page.getByTestId("profile-backups");
    await again.getByTestId("restore-open").click();
    await again.getByTestId("restore-file").setInputFiles({ name: file.suggestedFilename(), mimeType: "application/json", buffer: bundle });
    await again.getByTestId("restore-passphrase").fill(PASSPHRASE);
    await again.getByTestId("restore-go").click();
    // "A restore always becomes a new profile, then Ghostly switches to it" (ProfileBackups.tsx): the app
    // starts again on #/profile by itself. Navigating meanwhile would race that reload. The registry keeps the plain
    // name and a restored flag; the app shows "(restored)" in its language (profile.restoredName), "Pessoal (restaurado)".
    await expect(restored.page.getByTestId("profile-name"), "the restored profile is the one in use")
      .toHaveValue(filled("{{name}} (restored)", { name: alternatives("Personal") }), { timeout: 60_000 });
    await expect(restored.page.getByTestId("profile-row")).toHaveCount(2);
    restored.chatHash = b.chatHash;
    w.b = restored;
    await openChat(restored);
    await sees(restored, `olá from ${a.name}`);
    // A writes at once, while its side may still hold the old session: a message that goes into it gets no
    // receipt and is sent again by itself, under the same id, once the restored one is connected.
    await openChat(a);
    await say(a, "welcome back");
    for (const p of [a, restored]) await connected(p);
    await sees(restored, "welcome back", 120_000);
    await expect(chatPane(a).locator(".group").filter({ hasText: "welcome back" }).locator('[data-delivery="delivered"]')).toBeVisible({ timeout: 120_000 });
    await expect(chatPane(restored).getByText("welcome back", { exact: true })).toHaveCount(1);
    await say(restored, "restored and here");
    await sees(a, "restored and here", 120_000);
  },
};

/* ---------- the scenario ---------- */

const BLOCKS = new Map([identityBefore, pair, talk, delivery, transport, calls, files, identity, payments, group, restore].map((b) => [b.id, b]));

/** How the browser clients act each step out. */
export const BROWSER_BLOCKS: ReadonlyMap<string, (w: World) => Promise<void>> = new Map([...BLOCKS].map(([id, b]) => [id, b.run]));

/**
 * Runs one step as a test step named after it and its features, or notes why it did not run. `blocks` is how
 * the scenario's clients act the steps out: the browsers' (BROWSER_BLOCKS), or Desktop's (desktop.ts).
 */
export async function runStep<W extends { combo: Combination; info: TestInfo }>(step: Step, w: W, blocks: ReadonlyMap<string, (w: W) => Promise<void>>): Promise<void> {
  const features = step.features(w.combo);
  const title = `${step.title}${features.length ? ` [${features.join(", ")}]` : ""}`;
  const missing = unmet(step.requires(w.combo));
  const notYet = missing.length ? undefined : step.notYet?.(w.combo);
  if (missing.length || notYet) {
    const why = missing.length ? `needs ${missing.join("; ")}` : notYet!;
    w.info.annotations.push({ type: "skipped-block", description: `${step.id}: ${why}` });
    await test.step(`${title} — skipped: ${why}`, async () => {});
    return;
  }
  for (const f of features) w.info.annotations.push({ type: "feature", description: f });
  const block = blocks.get(step.id);
  await test.step(title, () => (block ? block(w) : Promise.resolve()));
}
