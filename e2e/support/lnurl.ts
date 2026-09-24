import { createServer, type Server } from "node:http";
import { mintEndpoint } from "./mint";

/**
 * A Lightning address server that lives in the test process, on a port of this machine: it answers
 * `/.well-known/lnurlp/<name>` (LUD-16) with a pay request (LUD-06) and hands out invoices of the test
 * mint (`E2E_MINT_URL`, or the public one) for its callback. The invoices carry the metadata as their
 * description, which is how a mint's invoice commits to it (an `h` tag is not something a mint sets).
 *
 * Plain HTTP is allowed by the app only for a server on this machine, so the address reads
 * `<name>@127.0.0.1:<port>`. The mint's invoices pay themselves and a Cashu wallet pays them by melting,
 * so `paid(name)` asks the mint whether the invoice it issued was settled.
 */
export interface LnurlName { description: string; minSat: number; maxSat: number; commentAllowed?: number }

export class LocalLnurlServer {
  private server?: Server;
  /** Every request answered, for assertions. */
  readonly requests: URL[] = [];
  /** The invoices handed out: which name, for how much, with what comment, and the mint quote behind it. */
  readonly invoices: { name: string; amountSat: number; comment?: string; quote: string; invoice: string }[] = [];
  readonly names = new Map<string, LnurlName>();

  /** The port is taken from `from` upwards, the first free one of this test's range. */
  port = 0;
  constructor(private readonly from: number, readonly mint = mintEndpoint()) {}

  get host(): string { return `127.0.0.1:${this.port}`; }
  address(name: string): string { return `${name}@${this.host}`; }
  metadata(name: string): string {
    const entry = this.names.get(name)!;
    return JSON.stringify([["text/plain", entry.description], ["text/identifier", this.address(name)]]);
  }

  async start(): Promise<void> {
    const server = createServer((request, response) => { void this.answer(new URL(request.url ?? "/", `http://${this.host}`)).then(({ status, body }) => {
      response.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
      response.end(JSON.stringify(body));
    }); });
    for (let port = this.from; port < this.from + 10; port++) {
      const taken = await new Promise<boolean>((resolve, reject) => {
        server.once("error", (error: NodeJS.ErrnoException) => (error.code === "EADDRINUSE" ? resolve(true) : reject(error)));
        server.listen(port, "127.0.0.1", () => resolve(false));
      });
      if (!taken) { this.port = port; this.server = server; return; }
    }
    throw new Error(`No free port from ${this.from}`);
  }

  close(): void { this.server?.closeAllConnections(); this.server?.close(); }

  /** Whether the mint settled an invoice issued for `name`. */
  async paid(name: string): Promise<boolean> {
    for (const issued of this.invoices.filter((i) => i.name === name)) {
      const state = await fetch(`${this.mint}/v1/mint/quote/bolt11/${issued.quote}`).then((r) => r.json() as Promise<{ state?: string }>).catch(() => ({ state: undefined }));
      if (state.state === "PAID" || state.state === "ISSUED") return true;
    }
    return false;
  }

  private async answer(url: URL): Promise<{ status: number; body: unknown }> {
    this.requests.push(url);
    const wellKnown = /^\/\.well-known\/lnurlp\/([a-z0-9._-]+)$/.exec(url.pathname);
    const callback = /^\/lnurlp\/([a-z0-9._-]+)\/callback$/.exec(url.pathname);
    const name = wellKnown?.[1] ?? callback?.[1];
    const entry = name ? this.names.get(name) : undefined;
    if (!name || !entry) return { status: 404, body: { status: "ERROR", reason: "No such user" } };
    if (wellKnown) return { status: 200, body: {
      tag: "payRequest", callback: `http://${this.host}/lnurlp/${name}/callback`,
      minSendable: entry.minSat * 1000, maxSendable: entry.maxSat * 1000, metadata: this.metadata(name), commentAllowed: entry.commentAllowed ?? 0,
    } };
    const msat = Number(url.searchParams.get("amount"));
    if (!Number.isInteger(msat) || msat % 1000 !== 0 || msat < entry.minSat * 1000 || msat > entry.maxSat * 1000) return { status: 200, body: { status: "ERROR", reason: "Amount out of bounds" } };
    const comment = url.searchParams.get("comment") ?? undefined;
    if (comment && comment.length > (entry.commentAllowed ?? 0)) return { status: 200, body: { status: "ERROR", reason: "Comment too long" } };
    const quote = await fetch(`${this.mint}/v1/mint/quote/bolt11`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ amount: msat / 1000, unit: "sat", description: this.metadata(name) }) })
      .then((r) => r.json() as Promise<{ quote: string; request: string }>);
    this.invoices.push({ name, amountSat: msat / 1000, comment, quote: quote.quote, invoice: quote.request });
    return { status: 200, body: { pr: quote.request, routes: [], successAction: { tag: "message", message: comment ? `Thanks for "${comment}"` : "Thanks" } } };
  }
}
