import { sha256 } from "@noble/hashes/sha2.js";
import { base64, base64url, hex } from "@scure/base";
import { decodeBolt11 } from "@ghostly/core";
import { fakeInvoice } from "../../src/engine/paymentAdapters/providers/testing";
import type { LndRequest, LndResponse, LndTransport } from "../../src/engine/paymentAdapters/providers/lnd";

/**
 * LND's REST API in memory, for the LND provider's unit tests: the answers have the shapes a real node
 * gives (checked against LND 0.19 on regtest), the network is regtest, and the invoices are the fakes'
 * (they decode; nobody can pay them). `pays` decides how an outgoing payment goes.
 */
export type FakePay = "succeed" | "fail" | "hang" | "error" | "lost";

export class FakeLndNode {
  balance = 100_000;
  network = "regtest";
  chain = "bitcoin";
  pays: FakePay = "succeed";
  /** Makes SendPaymentV2 answer with this error (before or after registering, per `registers`). */
  sendError?: { message: string; registers?: "SUCCEEDED" | "IN_FLIGHT" };
  readonly invoices = new Map<string, { request: string; amount: number; state: string; created: number }>();
  readonly payments = new Map<string, { status: string; fee_sat: string; payment_preimage?: string; failure_reason?: string }>();
  readonly requests: LndRequest[] = [];
  closed = false;

  transport(): LndTransport {
    return { request: async (request) => this.handle(request), close: () => { this.closed = true; } };
  }

  /** Someone paid our invoice. */
  settle(paymentHash: string) {
    const invoice = this.invoices.get(paymentHash);
    if (invoice && invoice.state === "OPEN") { invoice.state = "SETTLED"; this.balance += invoice.amount; }
  }

  private ok(...lines: unknown[]): LndResponse { return { status: 200, lines, timedOut: false }; }
  private fail(status: number, code: number, message: string): LndResponse { return { status, lines: [{ code, message, details: [] }], timedOut: false }; }

  private async handle(request: LndRequest): Promise<LndResponse> {
    if (this.closed) throw new Error("closed");
    this.requests.push(request);
    const { method, path } = request;
    if (method === "GET" && path === "/v1/getinfo") return this.ok({ alias: "fake-lnd", identity_pubkey: "02".padEnd(66, "0"), chains: [{ chain: this.chain, network: this.network }], synced_to_chain: true });
    if (method === "GET" && path === "/v1/balance/channels") return this.ok({ balance: String(this.balance), local_balance: { sat: String(this.balance), msat: String(this.balance * 1000) } });
    if (method === "POST" && path === "/v1/invoices") {
      const body = request.body as { value: string; memo: string; expiry: string };
      const preimage = crypto.getRandomValues(new Uint8Array(32)), hash = sha256(preimage);
      const invoice = fakeInvoice(Number(body.value), hash, body.memo, Number(body.expiry));
      this.invoices.set(hex.encode(hash), { request: invoice, amount: Number(body.value), state: "OPEN", created: Math.floor(Date.now() / 1000) });
      return this.ok({ r_hash: base64.encode(hash), payment_request: invoice, add_index: String(this.invoices.size), payment_addr: base64.encode(new Uint8Array(32)) });
    }
    let match = /^\/v1\/invoice\/([0-9a-f]{64})$/.exec(path);
    if (method === "GET" && match) {
      const found = this.invoices.get(match[1]);
      if (!found) return this.fail(404, 5, "unable to locate invoice");
      return this.ok({ state: found.state, value: String(found.amount), amt_paid_sat: found.state === "SETTLED" ? String(found.amount) : "0", creation_date: String(found.created), expiry: "3600" });
    }
    if (method === "POST" && path === "/v2/router/send") return this.send(request.body as { payment_request: string; fee_limit_sat: string });
    match = /^\/v2\/router\/track\/([A-Za-z0-9_-]+(?:%3D)*)\?no_inflight_updates=false$/.exec(path);
    if (method === "GET" && match) {
      const payment = this.payments.get(hex.encode(base64url.decode(decodeURIComponent(match[1]))));
      return payment ? this.ok({ result: payment }) : this.ok({ error: { code: 5, message: "payment isn't initiated", details: [] } });
    }
    return this.fail(404, 5, "Not Found");
  }

  private send({ payment_request, fee_limit_sat }: { payment_request: string; fee_limit_sat: string }): LndResponse {
    const decoded = decodeBolt11(payment_request)!;
    const hash = decoded.paymentHash!, amount = decoded.amountSat!;
    if (this.sendError) {
      if (this.sendError.registers) this.payments.set(hash, { status: this.sendError.registers, fee_sat: "0" });
      return this.ok({ error: { code: 2, message: this.sendError.message, details: [] } });
    }
    if (this.payments.get(hash)?.status === "SUCCEEDED") return this.ok({ error: { code: 6, message: "invoice is already paid", details: [] } });
    const fee = Math.min(Number(fee_limit_sat), 1);
    if (this.pays === "lost") throw new Error("Failed to fetch");
    if (this.pays === "hang") {
      this.payments.set(hash, { status: "IN_FLIGHT", fee_sat: "0" });
      return { status: 200, lines: [{ result: { payment_hash: hash, status: "IN_FLIGHT" } }], timedOut: true };
    }
    if (this.pays === "fail" || amount + fee > this.balance) {
      const failure_reason = this.pays === "fail" ? "FAILURE_REASON_NO_ROUTE" : "FAILURE_REASON_INSUFFICIENT_BALANCE";
      this.payments.set(hash, { status: "FAILED", fee_sat: "0", failure_reason });
      return this.ok({ result: { payment_hash: hash, status: "IN_FLIGHT" } }, { result: { payment_hash: hash, status: "FAILED", failure_reason } });
    }
    if (this.pays === "error") return this.ok({ error: { code: 2, message: "invoice expired", details: [] } });
    this.balance -= amount + fee;
    const done = { status: "SUCCEEDED", fee_sat: String(fee), fee_msat: String(fee * 1000), payment_preimage: "00".repeat(32) };
    this.payments.set(hash, done);
    return this.ok({ result: { payment_hash: hash, status: "IN_FLIGHT" } }, { result: { payment_hash: hash, ...done } });
  }
}

// -- macaroons, built the way LND bakes them (V2 binary, identifier = 3 ‖ MacaroonId protobuf) ----------

const varint = (n: number) => { const out: number[] = []; while (n >= 0x80) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } out.push(n); return out; };
const field = (tag: number, data: Uint8Array | number[]) => [...varint(tag), ...varint(data.length), ...data];
const bytes = (text: string) => [...new TextEncoder().encode(text)];

/** A macaroon with these permissions (`"invoices:read"`, or `"uri:/lnrpc.Lightning/GetInfo"`), as hex. */
export function bakeMacaroon(permissions: string[]): string {
  const ops = new Map<string, string[]>();
  for (const permission of permissions) {
    const at = permission.indexOf(":"), entity = permission.slice(0, at), action = permission.slice(at + 1);
    ops.set(entity, [...(ops.get(entity) ?? []), action]);
  }
  // Protobuf field keys: (field << 3) | 2, length-delimited.
  const pb = (fieldNumber: number, data: number[]) => [...varint((fieldNumber << 3) | 2), ...varint(data.length), ...data];
  const id = [3, ...pb(1, [...crypto.getRandomValues(new Uint8Array(16))]), ...pb(2, [0x30]),
    ...[...ops].flatMap(([entity, actions]) => pb(3, [...pb(1, bytes(entity)), ...actions.flatMap((a) => pb(2, bytes(a)))]))];
  const mac = [2, ...field(1, bytes("lnd")), ...field(2, id), 0, 0, ...field(6, [...crypto.getRandomValues(new Uint8Array(32))])];
  return hex.encode(new Uint8Array(mac));
}

export const ADMIN = ["address:read", "address:write", "info:read", "info:write", "invoices:read", "invoices:write", "macaroon:generate", "macaroon:read", "macaroon:write", "message:read", "message:write", "offchain:read", "offchain:write", "onchain:read", "onchain:write", "peers:read", "peers:write", "signer:generate", "signer:read"];
