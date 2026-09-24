import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, type TestInfo } from "@playwright/test";
import { signS3 } from "../../packages/browser/src/backup/s3";
import { testBitcoinWallet } from "../../packages/browser/test/helpers/bitcoinSign";
import { FakeWebln, FakeWeblnLedger } from "../../packages/browser/test/helpers/fakeWebln";
import { fingerprints, TestGpg } from "../../packages/browser/test/helpers/gpg";
import { strangerInvoice } from "../support/bolt11";
import { setClipboard } from "../support/clipboard";
import { startTestDomain, type TestDomain } from "../support/domain";
import { GIF } from "../support/fixtures";
import { injectNostrSigner } from "../support/nostrSigner";
import { LocalOidcIssuer } from "../support/oidcIssuer";
import type { LocalRelay } from "../support/relay";
import { testSshKey } from "../support/ssh";
import type { WebLNProvider } from "../../packages/browser/src/engine/paymentAdapters/providers/webln";
import {
  chatOption, chatPane, composerButton, either, go, home, nickname, openChat, paymentCard, reloaded, say, sees, setLanguage, useTestnet, wallet, type Actor,
} from "./actors";
import type { Combination } from "./dimensions";
import { CARD, type Step } from "./plan";
import { unmet } from "./requirements";

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
  expect(actor.page.getByTestId("connection-options")).toHaveAttribute("aria-label", new RegExp(`Connected · ${transport}`), { timeout });
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
      await a.page.getByRole("radio", { name: either("Text only") }).click();
      await expect.poll(() => copyInvite(a)).toMatch(/^pair2d\//);
    }
    const invite = await copyInvite(a);
    await joinWith(b, invite);
    for (const p of [a, b]) {
      await expect(p.page.getByPlaceholder("Message…")).toBeEnabled({ timeout: 90_000 });
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
  expect(chatPane(actor).getByText(either("Sent · waiting for receipt"))).toHaveCount(0, { timeout: 120_000 });

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

async function dhtOnly(actor: Actor, on: boolean): Promise<void> {
  const menu = actor.page.getByTestId("connection-menu");
  if ((await menu.getAttribute("open")) === null) await actor.page.getByTestId("connection-options").click();
  const choice = actor.page.getByRole("switch", { name: "DHT-only delivery" });
  if ((await choice.isChecked()) !== on) await choice.click();
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
  run: async ({ a, b, combo }) => {
    if (combo.delivery === "dht") {
      const back = await away(b);
      await say(a, "waiting in the DHT mailbox");
      await expect(chatPane(a).getByText(either("Sent · waiting for receipt"))).toBeVisible();
      await back();
      await sees(b, "waiting in the DHT mailbox");
      await expect(chatPane(a).getByText(either("Received by peer")).first()).toBeVisible({ timeout: 90_000 });
      // The rest of the story needs a live link: files, payments, groups.
      await dhtOnly(b, false);
      await dhtOnly(a, false);
      for (const p of [a, b]) await connected(p, "WebRTC", LIVE_AGAIN_MS);
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
      await expect(a.page.getByTestId("contact-status")).toHaveAttribute("aria-label", "Away · messages are held", { timeout: 60_000 });
      await say(a, "held in my S3 for you");
      await (await composerButton(a, (x) => x.page.getByTestId("file-input"))).setInputFiles({ name: "held.gif", mimeType: "image/gif", buffer: GIF });
      await expect(chatPane(a).locator(".group").filter({ hasText: "held in my S3 for you" })).toContainText(/Held/, { timeout: 60_000 });
      await back();
      await sees(b, "held in my S3 for you");
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
      const dialog = p.page.getByRole("dialog", { name: "Connection options" });
      // A browser has WebRTC only: the native transports are there, and refused.
      await expect(dialog.getByRole("radio", { name: "WebRTC", exact: true })).toBeEnabled();
      await expect(dialog.getByRole("radio", { name: "WebRTC", exact: true })).toBeChecked();
      for (const native of ["Iroh", "HyperDHT"]) await expect(dialog.getByRole("radio", { name: native, exact: true })).toBeDisabled();
      if (combo.transport === "webrtc-strict") {
        const fallback = dialog.getByRole("switch", { name: "Fallback" });
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

/* ---------- files ---------- */

export const files: Block = {
  id: "files",
  run: async ({ a, b }) => {
    const bytes = randomBytes(200 * 1024 + 13);
    const input = await composerButton(a, (x) => x.page.getByTestId("file-input"));
    await input.setInputFiles({ name: "matrix.bin", mimeType: "application/octet-stream", buffer: bytes });
    const save = chatPane(b).getByTestId("file-bubble").filter({ hasText: "matrix.bin" }).last().getByTestId("file-save");
    await expect(save).toBeVisible({ timeout: 90_000 });
    const downloading = b.page.waitForEvent("download");
    await save.click();
    const saved = await downloading;
    expect(createHash("sha256").update(readFileSync((await saved.path())!)).digest("hex")).toBe(createHash("sha256").update(bytes).digest("hex"));
    await (await composerButton(b, (x) => x.page.getByTestId("file-input"))).setInputFiles({ name: "ghost.gif", mimeType: "image/gif", buffer: GIF });
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
    await a.page.getByTestId("identity-add").click();
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
          await expect(add.getByTestId("add-identity-signer")).toHaveValue("nip07");
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
          await add.getByTestId("add-identity-signer").selectOption("dns");
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
          await add.getByTestId("add-identity-signer").selectOption("sparrow");
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
          await add.getByTestId("add-identity-signer").selectOption("oidc-email");
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
    await chatOption(a, "chat-identities-open");
    await a.page.getByTestId("chat-identities").getByTestId("chat-identity-share").click();
    await expect(a.page.getByTestId("chat-identity-mine-status")).toHaveText("Shared · verified by your contact", { timeout: 90_000 });
    await a.page.getByTestId("chat-identities").getByRole("button", { name: either("Close") }).click();
    await openChat(b);
    await expect(b.page.getByTestId("chat-identity-badges")).toBeVisible({ timeout: 60_000 });
    await chatOption(b, "chat-identities-open");
    const received = b.page.getByTestId("chat-identity-received");
    await expect(received).toHaveCount(1);
    await expect(received).toHaveAttribute("data-status", "verified");
    if (w.identity.seen) await expect(received).toContainText(w.identity.seen);
    await b.page.getByTestId("chat-identities").getByRole("button", { name: either("Close") }).click();
  },
};

/* ---------- wallet ---------- */


/** With a mint of our own, every peer adds it and makes it primary: the extension's engine cannot be rerouted to it. */
async function localMint(actor: Actor): Promise<void> {
  const url = process.env.E2E_MINT_URL;
  if (!url) return;
  await wallet(actor, "cashu");
  await actor.page.getByTestId("wallet-mint-url").fill(url);
  await actor.page.getByTestId("wallet-add-mint").click();
  await expect(actor.page.getByTestId("wallet-mint-url")).toHaveValue("");
  await actor.page.getByTestId("mint-row").filter({ hasText: new URL(url).host }).getByRole("button", { name: either("Make primary") }).click();
}

async function fundOverLightning(actor: Actor, sats: number): Promise<void> {
  await wallet(actor, "cashu");
  await actor.page.getByTestId("wallet-receive").click();
  await actor.page.getByTestId("wallet-receive-amount").fill(String(sats));
  await actor.page.getByTestId("wallet-create-invoice").click();
  await expect(actor.page.getByTestId("wallet-paid")).toBeVisible({ timeout: 60_000 });
}

/** Only these methods in this person's chat: a test mint pays a request's own Lightning invoice by itself. */
async function chatMethods(actor: Actor, off: string[]): Promise<void> {
  await openChat(actor);
  await chatOption(actor, "chat-payments-open");
  const dialog = actor.page.getByTestId("chat-payments");
  for (const method of off) {
    const toggle = dialog.getByTestId(`chat-payments-${method}`);
    if ((await toggle.getAttribute("aria-checked")) !== "false") await toggle.click();
  }
  await actor.page.getByTestId("chat-payments-save").click();
}

/** A note of the scenario's own on a payment: the one thing in its bubble no clock or amount can match by accident. */
const memo = (actor: Actor, text: string) => actor.page.getByLabel("What for? (optional)").fill(text);
const bubble = (actor: Actor, text: string) => chatPane(actor).getByTestId("payment-bubble").filter({ hasText: text }).last();

const approve = (scope: import("@playwright/test").Locator) => scope.getByTestId("payment-review").getByRole("button", { name: either("Approve payment") }).click();

async function cashuInChat({ a, b }: World): Promise<void> {
  for (const p of [a, b]) await localMint(p);
  await fundOverLightning(a, 100);
  // A direct send: reviewed, approved, received.
  await openChat(a);
  await paymentCard(a, "cashu");
  await a.page.getByTestId("payment-amount").fill("21");
  await memo(a, "matrix send");
  await a.page.getByTestId("payment-send").click();
  await approve(a.page.getByTestId("payment-composer"));
  await openChat(b);
  await expect(bubble(b, "matrix send").getByTestId("payment-state")).toHaveText(either("Received"), { timeout: 90_000 });
  await a.page.getByTestId("payment-composer").getByRole("button", { name: either("Close") }).click();
  // A request: B asks, A pays from the bubble.
  await chatMethods(b, ["lightning"]);
  await paymentCard(b, "cashu");
  await b.page.getByTestId("payment-amount").fill("10");
  await memo(b, "matrix request");
  await b.page.getByTestId("payment-request").click();
  await openChat(a);
  const request = bubble(a, "matrix request");
  await request.getByTestId("payment-pay").click();
  await approve(request);
  await expect(request.getByTestId("payment-state")).toHaveText(either("Paid"), { timeout: 90_000 });
  await expect(bubble(b, "matrix request").getByTestId("payment-state")).toHaveText(either("Paid"), { timeout: 90_000 });
}

async function lightningThroughMint({ a, b }: World): Promise<void> {
  for (const p of [a, b]) await localMint(p);
  await fundOverLightning(a, 100);
  // Out: an invoice the mint does not own, so the melt is real.
  await wallet(a, "lightning");
  await a.page.getByTestId("wallet-send").click();
  await a.page.getByTestId("wallet-pay-input").fill(strangerInvoice(25));
  await a.page.getByRole("button", { name: "Pay 25 sats" }).click();
  await a.page.getByRole("button", { name: either("Pay") }).click();
  await expect(a.page.getByTestId("wallet-notice")).toHaveText(either("Paid."), { timeout: 60_000 });
  // In, on B's side: an invoice of B's own wallet, which the test mint settles.
  await wallet(b, "lightning");
  await b.page.getByTestId("wallet-receive").click();
  await b.page.getByTestId("wallet-receive-amount").fill("25");
  await b.page.getByTestId("wallet-create-invoice").click();
  await expect(b.page.getByTestId("wallet-paid")).toBeVisible({ timeout: 60_000 });
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
    await wallet(p, "lightning");
    const picker = p.page.getByTestId("lightning-source");
    await picker.getByTestId("lightning-source-select").selectOption("webln");
    await expect(picker.getByTestId("webln-found")).toBeVisible();
    await picker.getByTestId("provider-form-webln").getByRole("button", { name: either("Connect browser wallet") }).click();
    await expect(picker.getByTestId("lightning-source-saved")).toBeVisible({ timeout: 30_000 });
  }
  await chatMethods(b, ["cashu"]);
  await paymentCard(b, "lightning");
  await b.page.getByTestId("payment-amount").fill("40");
  await memo(b, "matrix lightning request");
  await b.page.getByTestId("payment-request").click();
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
};

/** Mainnet: nothing moves; each rail's card says what it can do there, and a chat offers it. */
async function mainnetUi({ a, b, combo }: World): Promise<void> {
  const card = CARD[combo.rail];
  for (const p of [a, b]) {
    await wallet(p);
    await expect(p.page.getByTestId("wallet-mode").getByRole("radio", { name: "Mainnet" })).toHaveAttribute("aria-checked", "true");
    await expect(p.page.getByTestId("testnet-notice")).toHaveCount(0);
    await wallet(p, card);
    if (combo.rail === "bark") await expect(p.page.getByTestId("bark-unavailable")).toBeVisible();
    if (card === "bitcoin") await expect(p.page.getByTestId("onchain-source-none-offered")).toBeVisible();
    if (card === "lightning" && combo.rail !== "ln-mint") {
      // Only the sources Mainnet allows are offered; the test sources never are.
      const options = await p.page.getByTestId("lightning-source-select").locator("option").allTextContents();
      expect(options.join(" ")).not.toMatch(/fake|regtest/i);
    }
  }
  await openChat(a);
  const button = await composerButton(a, (x) => x.page.getByTestId("payment-button"));
  await expect(button).toBeEnabled({ timeout: 60_000 });
  await button.click();
  await expect(a.page.getByTestId(`payment-card-${card}`)).toBeVisible();
  await a.page.keyboard.press("Escape");
}

export const payments: Block = {
  id: "payments",
  run: async (w) => {
    if (w.combo.wallet === "mainnet") return mainnetUi(w);
    for (const p of [w.a, w.b]) await useTestnet(p);
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
      // The group's edges need a live link: this chat is Live even when the scenario's own is DHT.
      await a.page.getByRole("radio", { name: either("Live chat") }).click();
      await joinWith(c, await copyInvite(a));
      await expect(c.page.getByPlaceholder("Message…")).toBeEnabled({ timeout: 90_000 });
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
    await expect(restored.page.getByTestId("profile-row")).toHaveCount(2, { timeout: 60_000 });
    // "A restore always becomes a new profile, then Ghostly switches to it" (ProfileBackups.tsx).
    await go(restored, "#/profile");
    await expect(restored.page.getByTestId("profile-name"), "the restored profile is the one in use").toHaveValue(/\(restored\)$/, { timeout: 60_000 });
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
    await expect(chatPane(a).locator(".group").filter({ hasText: "welcome back" })).toContainText("Received by peer", { timeout: 120_000 });
    await expect(chatPane(restored).getByText("welcome back", { exact: true })).toHaveCount(1);
    await say(restored, "restored and here");
    await sees(a, "restored and here", 120_000);
  },
};

/* ---------- the scenario ---------- */

const BLOCKS = new Map([identityBefore, pair, talk, delivery, transport, files, identity, payments, group, restore].map((b) => [b.id, b]));

/** Runs one step as a test step named after it and its features, or notes why it did not run. */
export async function runStep(step: Step, w: World): Promise<void> {
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
  const block = BLOCKS.get(step.id);
  await test.step(title, () => (block ? block.run(w) : Promise.resolve()));
}
