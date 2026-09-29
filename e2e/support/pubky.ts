import type { BrowserContext, Page, Route } from "@playwright/test";
import jsQR from "jsqr";
import { answerDoh, queryFromUrl } from "../../packages/browser/test/helpers/dohZone";
import type { LocalRelay } from "./relay";

/**
 * Pubky for the suites (WISP 302), against Pubky's own testnet in e2e/infra (ghostly-e2e-pubky-testnet): a
 * homeserver that names itself pubky-homeserver.e2e.ghostly.tools in its Pkarr record, its Pkarr relay and an HTTP
 * relay. Nothing reaches Pubky's servers: in the browsers, Pubky's public HTTP relay and the homeserver's name are
 * routed to the testnet; Pubky's Pkarr relays are the test's LocalRelay (seeded with the homeserver's record); and
 * Pubky Passport is a stand-in page. In the test process, `PubkyApprover` stands in for Ring and Passport: a
 * throwaway key signed up at the homeserver, approving requests with the Pubky SDK, as they would.
 *
 * Authorization URLs carry a relay secret: a throwaway one here, but still never printed.
 */

export const PUBKY_HOMESERVER_HOST = "pubky-homeserver.e2e.ghostly.tools";
/** The testnet's fixed homeserver key (pubky-testnet's `testnet_keypair`). */
export const PUBKY_HOMESERVER_KEY = "8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo";
const PUBLIC_HTTP_RELAY = "https://httprelay.pubky.app";
const PASSPORT = "https://passport.pubky.app";
const RESOLVERS = /^https:\/\/(dns\.quad9\.net|cloudflare-dns\.com|dns\.google)\/dns-query\?/;
/** A public address for the homeserver's name: a contact's app refuses one that resolves to a private network. */
const HOMESERVER_ADDRESS = "93.184.215.14";

export const pubkyTestnet = () => {
  const [homeserver, httpRelay, pkarrRelay] = ["GHOSTLY_PUBKY_HOMESERVER_URL", "GHOSTLY_PUBKY_HTTP_RELAY_URL", "GHOSTLY_PUBKY_PKARR_RELAY_URL"].map((name) => process.env[name]);
  return homeserver && httpRelay && pkarrRelay ? { homeserver, httpRelay, pkarrRelay } : undefined;
};

/** Where a public Pubky URL goes in the testnet, or undefined for anything else. */
function testnetUrl(url: string, relayUrl?: string): string | undefined {
  const testnet = pubkyTestnet()!;
  const target = new URL(url);
  const base = target.origin === PUBLIC_HTTP_RELAY ? testnet.httpRelay
    : target.host === PUBKY_HOMESERVER_HOST ? testnet.homeserver
    : relayUrl && /^https:\/\/pkarr\.pubky\.(org|app)$/.test(target.origin) ? relayUrl
    : undefined;
  return base && `${base}${target.pathname}${target.search}`;
}

/** Forwards a request to the testnet, as it is (method, headers, body), and its answer back. */
async function forward(route: Route): Promise<void> {
  const to = testnetUrl(route.request().url());
  if (!to) return route.abort("addressunreachable");
  try {
    // The relay holds a poll up to ~25 s before it answers 408.
    const response = await route.fetch({ url: to, timeout: 60_000, maxRedirects: 0 });
    await route.fulfill({ response });
  } catch { await route.abort("connectionfailed").catch(() => {}); }
}

/**
 * Routes one browser context's Pubky traffic to the testnet and shows the Passport stand-in, where Approve hands
 * the request to `approver`. Seeds `relay` with the homeserver's record, which the testnet published on its own DHT.
 */
export async function attachPubky(context: BrowserContext, relay: LocalRelay, approver?: PubkyApprover): Promise<void> {
  await seedHomeserver(relay);
  await context.route(`${PUBLIC_HTTP_RELAY}/**`, forward);
  await context.route(`https://${PUBKY_HOMESERVER_HOST}/**`, forward);
  // The homeserver's name resolves nowhere: answer its address lookups, and leave any other name to other routes.
  await context.route(RESOLVERS, (route) => {
    const query = queryFromUrl(route.request().url());
    // The question's labels, length-prefixed: the host's first label is enough to tell it apart.
    if (!Buffer.from(query).includes(PUBKY_HOMESERVER_HOST.split(".")[0])) return route.fallback();
    const answer = answerDoh(query, { a: { [PUBKY_HOMESERVER_HOST]: [HOMESERVER_ADDRESS] } });
    return route.fulfill({ status: 200, headers: { "content-type": "application/dns-message", "access-control-allow-origin": "*", "cache-control": "no-store" }, body: Buffer.from(answer) });
  });
  await context.route(`${PASSPORT}/**`, (route) => route.fulfill({ contentType: "text/html", body: PASSPORT_STAND_IN }));
  if (approver) {
    await context.exposeBinding("ghostlyTestPassportApprove", async (_source, fragment: string) => {
      const request = new URLSearchParams(fragment.replace(/^#/, "")).get("d");
      if (!request) throw new Error("No request in the fragment");
      await approver.approve(request);
    });
  }
}

/** Puts the testnet homeserver's record, which it published on the testnet's own DHT, in the test's relay. */
export async function seedHomeserver(relay: LocalRelay): Promise<void> {
  if (relay.packets.has(PUBKY_HOMESERVER_KEY)) return;
  const answer = await fetch(`${pubkyTestnet()!.pkarrRelay}/${PUBKY_HOMESERVER_KEY}`);
  if (!answer.ok) throw new Error(`The Pubky testnet's relay has no homeserver record (${answer.status})`);
  relay.packets.set(PUBKY_HOMESERVER_KEY, Buffer.from(await answer.arrayBuffer()));
}

/**
 * Stands in for passport.pubky.app/authorize: what the request asks, Approve and Cancel. The request stays in the
 * fragment, as Passport keeps it; Approve hands it to the test's approver.
 */
const PASSPORT_STAND_IN = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Pubky Passport (test stand-in)</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{margin:0;font:15px/1.5 system-ui,sans-serif;background:#05050a;color:#e0e0e3;display:grid;place-items:center;min-height:100vh}
main{width:min(420px,90vw);padding:28px;border:1px solid #2a2a30;border-radius:16px;background:#15151a}h1{font-size:18px;margin:0 0 4px}
.muted{color:#89898f;font-size:13px}code{display:block;margin:12px 0;padding:10px;border-radius:8px;background:#05050a;font-size:12px;word-break:break-all}
button{font:inherit;padding:10px 16px;border-radius:10px;border:0;cursor:pointer;margin-right:8px}#approve{background:#fff;color:#05050a;font-weight:600}#cancel{background:#2a2a30;color:#e0e0e3}</style></head>
<body><main><h1>Pubky Passport</h1><p class="muted">Test stand-in for passport.pubky.app. Keys are throwaway ones.</p>
<p><strong id="app">An app</strong> asks for access:</p><code id="caps"></code>
<button id="approve">Approve</button><button id="cancel">Cancel</button><p id="done" class="muted" role="status"></p></main>
<script>
const request = new URLSearchParams(location.hash.slice(1)).get("d") || "";
let url; try { url = new URL(request); } catch {}
document.getElementById("caps").textContent = url ? (url.searchParams.get("caps") || "(no capabilities)") : "(no request)";
document.getElementById("app").textContent = url?.searchParams.get("x-source") || url?.searchParams.get("cid") || "An app";
document.getElementById("approve").onclick = async () => {
  document.getElementById("done").textContent = "Approving…";
  try { await window.ghostlyTestPassportApprove(location.hash); document.getElementById("done").textContent = "Approved. You can close this window."; }
  catch { document.getElementById("done").textContent = "Could not approve."; }
};
document.getElementById("cancel").onclick = () => window.close();
</script></body></html>`;

/**
 * Stands in for Pubky Ring and Passport in the test process: a throwaway key, signed up at the testnet's homeserver,
 * that approves Pubky auth requests with the SDK. The SDK's traffic goes to the testnet and the test's relay.
 */
export class PubkyApprover {
  key = "";
  private signer: import("@synonymdev/pubky").Signer | undefined;
  private restoreFetch: (() => void) | undefined;
  readonly approved: string[] = [];

  private relayUrl = "";

  constructor(private relay: LocalRelay) {}

  async start(): Promise<this> {
    await seedHomeserver(this.relay);
    this.relayUrl = await this.relay.listen();
    this.patchFetch();
    const { Keypair, Pubky, PublicKey } = await import("@synonymdev/pubky");
    const keypair = Keypair.random();
    const signer = new Pubky().signer(keypair);
    await signer.signup(PublicKey.from(PUBKY_HOMESERVER_KEY), null);
    this.signer = signer;
    const publicKey = signer.publicKey;
    this.key = publicKey.z32();
    publicKey.free();
    return this;
  }

  /** Approves a request as the person would in Ring or Passport; remembers only what it asked for. */
  async approve(authorizationUrl: string): Promise<void> {
    if (!this.signer) throw new Error("Start the approver first");
    await this.signer.approveAuthRequest(authorizationUrl);
    this.approved.push(new URL(authorizationUrl).searchParams.get("caps") ?? "");
  }

  /** A file of this key as anyone reads it: the homeserver, directly. */
  async read(path: string): Promise<{ status: number; text: string }> {
    const r = await globalThis.fetch(`${pubkyTestnet()!.homeserver}${path}`, { headers: { "pubky-host": this.key } });
    return { status: r.status, text: await r.text() };
  }

  stop(): void {
    this.signer?.free();
    this.signer = undefined;
    this.restoreFetch?.();
    this.restoreFetch = undefined;
  }

  /** The SDK fetches with the global fetch: send its public Pubky URLs to the testnet and the test's relay. */
  private patchFetch() {
    const original = globalThis.fetch;
    const relayUrl = this.relayUrl;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const to = testnetUrl(url, relayUrl);
      if (!to) return original(input, init);
      if (input instanceof Request) {
        const body = ["GET", "HEAD"].includes(input.method) ? undefined : await input.arrayBuffer();
        return original(to, { method: input.method, headers: input.headers, body, ...init });
      }
      return original(to, init);
    }) as typeof fetch;
    this.restoreFetch = () => { globalThis.fetch = original; };
  }
}

/** Reads the request out of the approval screen's QR code, the way Pubky Ring scans it. */
export async function scanApprovalQr(page: Page): Promise<string> {
  const image = await page.getByTestId("approval-qr").locator("svg").evaluate(async (svg) => {
    const size = 320;
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(img, 32, 32, size - 64, size - 64);
    return { data: Array.from(ctx.getImageData(0, 0, size, size).data), size };
  });
  const code = jsQR(Uint8ClampedArray.from(image.data), image.size, image.size);
  if (!code?.data) throw new Error("The approval QR code did not decode");
  return code.data;
}
