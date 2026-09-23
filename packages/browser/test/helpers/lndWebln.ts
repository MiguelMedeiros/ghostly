import { execFileSync } from "node:child_process";
import { request } from "node:https";
import type { WebLNInfo, WebLNProvider } from "../../src/engine/paymentAdapters/providers/webln";

/**
 * A WebLN wallet backed by a real LND node of the disposable regtest stack (e2e/support/webln-regtest):
 * what a browser wallet such as Alby does in front of its node, minus the prompts. Used by the gated
 * contract test (Node) and by the gated e2e, where the page's `window.webln` calls it through a binding.
 *
 * The node's TLS certificate and admin macaroon are read from its container into memory, used in the
 * requests' headers, and never printed. Worthless regtest sats only.
 */
export type LndNode = "alice" | "bob";
export const LND_REST: Record<LndNode, number> = { alice: 44610, bob: 44611 };
const DIR = "/root/.lnd";

const fromContainer = (node: LndNode, path: string) => execFileSync("docker", ["exec", `ghostly-webln-${node}`, "cat", path], { stdio: ["ignore", "pipe", "ignore"] });
const b64hex = (value: string | undefined) => (value ? Buffer.from(value, "base64").toString("hex") : undefined);

export class LndRest {
  private readonly ca: Buffer;
  private readonly macaroon: string;
  constructor(readonly node: LndNode) {
    this.ca = fromContainer(node, `${DIR}/tls.cert`);
    this.macaroon = fromContainer(node, `${DIR}/data/chain/bitcoin/regtest/admin.macaroon`).toString("hex");
  }

  call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: LND_REST[this.node], path, method, ca: this.ca, servername: "localhost", timeout: 60_000, headers: { "Grpc-Metadata-macaroon": this.macaroon, "content-type": "application/json" } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: { message?: string } & Record<string, unknown>;
          try { json = JSON.parse(text); } catch { return reject(new Error(`LND ${this.node}: ${res.statusCode}`)); }
          if ((res.statusCode ?? 500) >= 400) return reject(new Error(json.message ?? `LND ${this.node}: ${res.statusCode}`));
          resolve(json as T);
        });
      });
      req.on("timeout", () => req.destroy(new Error("LND did not answer")));
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }

  /** Sats this node can spend over its channels. */
  async channelBalance() { return Number((await this.call<{ local_balance?: { sat?: string } }>("GET", "/v1/balance/channels")).local_balance?.sat ?? 0); }
  async invoice(amount: number, memo = "ghostly e2e") { return (await this.call<{ payment_request: string }>("POST", "/v1/invoices", { value: String(amount), memo })).payment_request; }
  /** Pays as the node itself, outside any browser: someone else paying the person's invoice. */
  async pay(paymentRequest: string) {
    const answer = await this.call<{ payment_error?: string; payment_preimage?: string }>("POST", "/v1/channels/transactions", { payment_request: paymentRequest });
    if (answer.payment_error) throw new Error(answer.payment_error);
    return b64hex(answer.payment_preimage)!;
  }
}

/** The WebLN a browser wallet in front of this node would inject. */
export function lndWebln(node: LndNode | LndRest): WebLNProvider & { lnd: LndRest } {
  const lnd = typeof node === "string" ? new LndRest(node) : node;
  let enabled = false;
  const check = () => { if (!enabled) throw new Error("Provider must be enabled before calling"); };
  return {
    lnd,
    async enable() { enabled = true; return { enabled: true }; },
    // Like Alby: a name and the methods it has, and no word about the chain (Ghostly works that out).
    async getInfo(): Promise<WebLNInfo> {
      check();
      const info = await lnd.call<{ alias: string; identity_pubkey: string }>("GET", "/v1/getinfo");
      return { node: { alias: info.alias, pubkey: info.identity_pubkey }, methods: ["getInfo", "makeInvoice", "sendPayment", "getBalance", "lookupInvoice"] };
    },
    async getBalance() { check(); return { balance: await lnd.channelBalance(), currency: "sats" }; },
    async makeInvoice({ amount, defaultMemo }) { check(); return { paymentRequest: await lnd.invoice(Number(amount), defaultMemo) }; },
    async sendPayment(paymentRequest) {
      check();
      const answer = await lnd.call<{ payment_error?: string; payment_preimage?: string; payment_route?: { total_fees?: string } }>("POST", "/v1/channels/transactions", { payment_request: paymentRequest, fee_limit: { fixed: "100" } });
      if (answer.payment_error) throw new Error(answer.payment_error);
      return { preimage: b64hex(answer.payment_preimage), route: { total_fees: Number(answer.payment_route?.total_fees ?? 0) } };
    },
    // Incoming invoices of the node, and (like NWC's lookup_invoice) its outgoing payments too.
    async lookupInvoice({ paymentHash }) {
      check();
      if (!paymentHash || !/^[0-9a-f]{64}$/.test(paymentHash)) throw new Error("A payment hash is needed");
      try {
        const invoice = await lnd.call<{ state?: string; r_preimage?: string }>("GET", `/v1/invoice/${paymentHash}`);
        return { paid: invoice.state === "SETTLED", ...(invoice.state === "SETTLED" ? { preimage: b64hex(invoice.r_preimage) } : {}) };
      } catch (error) {
        const { payments } = await lnd.call<{ payments?: { payment_hash: string; status: string; payment_preimage?: string }[] }>("GET", "/v1/payments?include_incomplete=true&max_payments=200&reversed=true");
        const payment = payments?.find((p) => p.payment_hash === paymentHash);
        if (!payment) throw error;
        return { paid: payment.status === "SUCCEEDED", ...(payment.status === "SUCCEEDED" ? { preimage: payment.payment_preimage } : {}) };
      }
    },
  };
}
