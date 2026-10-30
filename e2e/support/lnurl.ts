import { createServer, type Server } from "node:http";
import { strangerInvoice } from "./bolt11";

/**
 * A Lightning address server that lives in the test process, on a port of this machine: it answers
 * `/.well-known/lnurlp/<name>` (LUD-16) with a pay request (LUD-06) and hands out a stranger's invoice
 * (support/bolt11.ts) for its callback, carrying the metadata as its description: one way an invoice
 * commits to it, the other being an `h` tag.
 *
 * Not one of the test mint's own invoices: those pay themselves about a second after they are made, and a
 * melt that reaches the mint after that is refused as "Invoice already paid", so a slow Pay lost the race.
 * A stranger's invoice is paid only by the melt, by the suite's mint or the public one alike.
 * Nothing asks a stranger whether it was paid: a test reads the payer's balance instead.
 *
 * Plain HTTP is allowed by the app only for a server on this machine, so the address reads
 * `<name>@127.0.0.1:<port>`.
 */
export interface LnurlName { description: string; minSat: number; maxSat: number; commentAllowed?: number }

export class LocalLnurlServer {
  private server?: Server;
  /** Every request answered, for assertions. */
  readonly requests: URL[] = [];
  /** The invoices handed out: which name, for how much, with what comment. */
  readonly invoices: { name: string; amountSat: number; comment?: string; invoice: string }[] = [];
  readonly names = new Map<string, LnurlName>();

  /** The port is taken from `from` upwards, the first free one of this test's range. */
  port = 0;
  constructor(private readonly from: number) {}

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
    const invoice = strangerInvoice(msat / 1000, this.metadata(name));
    this.invoices.push({ name, amountSat: msat / 1000, comment, invoice });
    return { status: 200, body: { pr: invoice, routes: [], successAction: { tag: "message", message: comment ? `Thanks for "${comment}"` : "Thanks" } } };
  }
}
