import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { BrowserContext } from "@playwright/test";
import { answerDoh, type Zone } from "../../packages/browser/test/helpers/dohZone";
import { endpoints } from "../infra/env.mjs";

/**
 * A test domain of our own, for domain identity proofs.
 *
 * Two local servers, on two ports of the environment's range per slot (from E2E_DOMAIN_PORT, e2e/infra/env.mjs):
 *  - a DNS-over-HTTPS responder (RFC 8484 wire format) answering from `zone`;
 *  - a web server answering `/.well-known/*` for the test domain from `files`.
 *
 * The app is never told: it still asks the public resolvers and
 * `https://<domain>/.well-known/…`, exactly as in production, and the browser
 * context routes those requests here, the way support/mint.ts and relay.ts do.
 * Nothing test-specific ships in the build. Any other request to the test
 * domain fails, so nothing leaks to the real one.
 *
 * The domain is a random subdomain of ghostly.tools, a domain the project
 * owns: a route that failed to apply would reach our own DNS, not a stranger's.
 */
export interface TestDomain {
  domain: string;
  zone: Zone;
  /** Path (with query) → body; absent paths answer 404. */
  files: Map<string, string>;
  /** Every DNS question and file path asked, in order. */
  asked: string[];
  attach(context: BrowserContext): Promise<void>;
  publishTxt(value: string): void;
  unpublish(): void;
  close(): Promise<void>;
}

const RESOLVERS = /^https:\/\/(dns\.quad9\.net|cloudflare-dns\.com|dns\.google)\/dns-query\?/;

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

/** How many workers can each have a test domain at once: 40 slots of two ports, 47120-47199 by default. */
export const DOMAIN_SLOTS = 40;

/** `slot` keeps parallel Playwright workers on distinct ports; `base` moves them elsewhere (the matrix has its own range). */
export async function startTestDomain(slot = 0, base = endpoints.domainPort): Promise<TestDomain> {
  if (slot < 0 || slot >= DOMAIN_SLOTS) throw new Error(`Test domain slot ${slot} out of 0-${DOMAIN_SLOTS - 1}`);
  const domain = `e2e-${Math.random().toString(36).slice(2, 10)}.ghostly.tools`;
  const zone: Zone = { a: { [domain]: ["203.0.113.7"] }, txt: {}, ttl: 1 };
  const files = new Map<string, string>();
  const asked: string[] = [];

  const doh = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const b64 = url.searchParams.get("dns");
    if (req.method !== "GET" || url.pathname !== "/dns-query" || !b64) { res.writeHead(400).end(); return; }
    const query = Buffer.from(b64, "base64url");
    const labels: string[] = [];
    for (let pos = 12; query[pos]; pos += 1 + query[pos]) labels.push(query.subarray(pos + 1, pos + 1 + query[pos]).toString());
    asked.push(`dns ${labels.join(".")}`);
    const answer = answerDoh(new Uint8Array(query), zone);
    res.writeHead(200, { "content-type": "application/dns-message", "access-control-allow-origin": "*", "cache-control": "no-store" }).end(Buffer.from(answer));
  });
  const web = createServer((req, res) => {
    const path = req.url ?? "/";
    asked.push(`web ${path}`);
    const body = files.get(path);
    if (body === undefined) { res.writeHead(404, { "access-control-allow-origin": "*" }).end("not found"); return; }
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" }).end(body);
  });
  const dohPort = await listen(doh, base + slot * 2);
  const webPort = await listen(web, base + 1 + slot * 2);

  return {
    domain, zone, files, asked,
    async attach(context) {
      await context.route(RESOLVERS, async route => {
        const { search } = new URL(route.request().url());
        await route.fulfill({ response: await route.fetch({ url: `http://127.0.0.1:${dohPort}/dns-query${search}` }) });
      });
      await context.route(url => url.hostname === domain || url.hostname.endsWith(`.${domain}`), async route => {
        const target = new URL(route.request().url());
        if (target.protocol !== "https:" || !target.pathname.startsWith("/.well-known/")) { await route.abort(); return; }
        await route.fulfill({ response: await route.fetch({ url: `http://127.0.0.1:${webPort}${target.pathname}${target.search}` }) });
      });
    },
    publishTxt(value) { zone.txt = { [`_ghostly.${domain}`]: [value] }; },
    unpublish() { zone.txt = {}; files.clear(); },
    close: () => Promise.all([doh, web].map(s => new Promise<void>(r => s.close(() => r())))).then(() => undefined),
  };
}
