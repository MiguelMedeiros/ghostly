import { request as httpRequest } from "node:http";
import type { BrowserContext, Route } from "@playwright/test";
import { answerDoh, type Zone } from "../../packages/browser/test/helpers/dohZone";
import { endpoints } from "../infra/env.mjs";

/**
 * A local AT Protocol network for Bluesky identity proofs: the PLC directory and reference PDS of
 * e2e/infra/atproto (endpoints.atproto). The PDS believes it is https://pds.ghostly.test; the suite's build
 * looks DIDs up at https://plc.ghostly.test (VITE_ATPROTO_TEST_PLC, honoured only for a `.test` host). The
 * browser context routes both names here, and answers the DNS-over-HTTPS resolvers for the accounts' handles
 * (`_atproto.<handle>` TXT), so the app sees HTTPS and real protocol answers only; nothing reaches the
 * real Bluesky. Accounts are made per test, with throwaway passwords, on a throwaway server.
 */
export const ATPROTO_TEST_PLC = "https://plc.ghostly.test";
export const ATPROTO_PDS_HOST = "pds.ghostly.test";
const RESOLVERS = /^https:\/\/(dns\.quad9\.net|cloudflare-dns\.com|dns\.google)\/dns-query\?/;

export interface AtprotoAccount { handle: string; did: string; password: string }

/** Whether the environment has the AT Protocol network (the suite's gate). */
export const atprotoConfigured = () => !!process.env.E2E_ATPROTO_PDS_URL && !!process.env.E2E_ATPROTO_PLC_URL;

export class LocalAtproto {
  /** The handles' TXT records, and an address for the PDS's name: a contact's app checks it is not a private one. */
  readonly zone: Zone = { txt: {}, a: { [ATPROTO_PDS_HOST]: ["203.0.113.10"] }, ttl: 1 };

  constructor(readonly pds = endpoints.atproto.pds, readonly plc = endpoints.atproto.plc) {}

  /** A fresh account on the PDS, its handle findable by DNS. */
  async account(name: string): Promise<AtprotoAccount> {
    const handle = `${name}-${Math.random().toString(36).slice(2, 8)}.${ATPROTO_PDS_HOST}`;
    const password = `ghostly-e2e-${Math.random().toString(36).slice(2)}`;
    const response = await fetch(`${this.pds}/xrpc/com.atproto.server.createAccount`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle, password, email: `${handle.split(".")[0]}@example.test` }),
    });
    const body = await response.json() as { did?: string; message?: string };
    if (!response.ok || !body.did) throw new Error(`createAccount ${handle}: ${response.status} ${body.message ?? ""}`);
    this.zone.txt![`_atproto.${handle}`] = [`did=${body.did}`];
    return { handle, did: body.did, password };
  }

  /** The Ghostly proof records in an account's repository, read straight from the PDS. */
  async proofRecords(did: string): Promise<{ uri: string; value: { statement: string } }[]> {
    const url = `${this.pds}/xrpc/com.atproto.repo.listRecords?${new URLSearchParams({ repo: did, collection: "tools.ghostly.proof" })}`;
    const body = await (await fetch(url)).json() as { records: { uri: string; value: { statement: string } }[] };
    return body.records;
  }

  async attach(context: BrowserContext): Promise<void> {
    await context.route(`https://${ATPROTO_PDS_HOST}/**`, route => this.forward(route, this.pds, ATPROTO_PDS_HOST));
    await context.route(`${ATPROTO_TEST_PLC}/**`, route => this.forward(route, this.plc, new URL(ATPROTO_TEST_PLC).host));
    await context.route(RESOLVERS, async route => {
      const query = Buffer.from(new URL(route.request().url()).searchParams.get("dns") ?? "", "base64url");
      await route.fulfill({ status: 200, headers: { "content-type": "application/dns-message", "access-control-allow-origin": "*", "cache-control": "no-store" }, body: Buffer.from(answerDoh(new Uint8Array(query), this.zone)) });
    });
  }

  /**
   * One request to the local service, as the browser made it to the https name: same method, headers (cookies
   * included), body and Host, no redirect followed (the browser follows them itself, back through this route).
   */
  private async forward(route: Route, base: string, host: string): Promise<void> {
    const req = route.request();
    const url = new URL(req.url());
    const target = new URL(url.pathname + url.search, base);
    const headers: Record<string, string> = { ...(await req.allHeaders()), host, "x-forwarded-proto": "https", "x-forwarded-host": host };
    delete headers["accept-encoding"];
    // Chromium adds the Fetch Metadata headers after the point where Playwright intercepts, and the PDS's OAuth pages
    // require them: rebuild what the browser would send.
    if (!headers["sec-fetch-site"]) {
      const from = headers.origin ?? (headers.referer ? new URL(headers.referer).origin : undefined);
      const same = from === `https://${host}`;
      const type = req.resourceType();
      const dest = ({ stylesheet: "style", script: "script", image: "image", font: "font", manifest: "manifest" } as Record<string, string>)[type];
      Object.assign(headers, req.isNavigationRequest()
        ? { "sec-fetch-site": same ? "same-origin" : from ? "cross-site" : "none", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" }
        : dest ? { "sec-fetch-site": "same-origin", "sec-fetch-mode": type === "script" ? "cors" : "no-cors", "sec-fetch-dest": dest }
          : { "sec-fetch-site": same ? "same-origin" : "cross-site", "sec-fetch-mode": same ? "same-origin" : "cors", "sec-fetch-dest": "empty" });
    }
    const body = req.postDataBuffer();
    const answer = await new Promise<{ status: number; headers: Record<string, string>; body: Buffer }>((resolve, reject) => {
      const outgoing = httpRequest(target, { method: req.method(), headers }, incoming => {
        const chunks: Buffer[] = [];
        incoming.on("data", chunk => chunks.push(chunk));
        incoming.on("end", () => {
          const out: Record<string, string> = {};
          for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) out[name] = Array.isArray(value) ? value.join("\n") : value;
          resolve({ status: incoming.statusCode ?? 502, headers: out, body: Buffer.concat(chunks) });
        });
        incoming.on("error", reject);
      });
      outgoing.on("error", reject);
      if (body) outgoing.write(body);
      outgoing.end();
    });
    await route.fulfill(answer);
  }
}
