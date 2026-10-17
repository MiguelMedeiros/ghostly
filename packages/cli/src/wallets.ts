import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import type { WalletNetwork } from "@ghostly/core";
import type { EngineState, NetworkWalletsView, PaymentView, WalletInstanceView, WalletOffer, WalletType } from "@ghostly/browser/shared/types";
import { bool, chatOf, inviteTaken, node, num, oneOf, sentAt, state, str, type ApiContext, type Method, type Params } from "./apiKit";
import { paymentNetwork } from "@ghostly/browser/engine/paymentAdapters/walletInstances";
import { CliError, type ErrorCode } from "./errors";
import { findSecret } from "../../../apps/ui/src/lib/parse/secrets";

/**
 * Wallets and payments (WISP 1100, phase 2): the app's wallet deck and a chat's payment sheet, as methods. Test
 * networks move nothing real. On Mainnet every spend passes `confirmedReal`, which the engine requires, only when the
 * call says `confirmReal: true` (the CLI's `--confirm-real`): no flag, no spend.
 */

const NETWORKS = ["mainnet", "testnet"] as const;
const TYPES = ["cashu", "lightning", "arkade", "bark", "spark", "bitcoin", "fedimint", "usdt"] as const;
const METHODS = ["cashu", "arkade", "usdt", "bark", "bitcoin", "fedimint", "spark"] as const;
const CHAT_METHODS = ["cashu", "lightning", ...METHODS.filter((m) => m !== "cashu")] as const;

/**
 * What the app has and a headless Ghostly cannot run yet, and why (WISP 1100 § Wallet SDKs on Node). New offers
 * them as unavailable; creating one is refused before the engine is asked.
 */
export const NODE_GAPS: Partial<Record<WalletType, string>> = {
  bark: "Bark's SDK ships a browser build only: its WebAssembly needs a browser window. Use it from the app.",
};

/** Sources the engine lists that live in a browser page (`window.webln`): a headless Ghostly never offers them. */
const BROWSER_SOURCES = new Set(["webln"]);

/** The sources of an offer a headless Ghostly can connect. */
const nodeSources = (offer: WalletOffer | undefined) => offer?.providers?.filter((p) => !BROWSER_SOURCES.has(p.id));

/**
 * What `wallet create` was given checked against the offer's own form, before the engine is asked: a source, a field
 * or a flag left out, or one the wallet does not take, is the person's value, said naming the flag. Before, the engine
 * refused it in the app's words ("Enter connection uri", "Nothing was saved; try again") as `engine`, or the flag was
 * dropped without a word.
 */
function createChecked(type: WalletType, n: WalletNetwork, offer: WalletOffer | undefined, provider: string | undefined, values: Record<string, string>, params: Params): void {
  if (type !== "lightning" && type !== "bitcoin") {
    if (provider || Object.keys(values).length) throw new CliError("usage", `--provider and --value name a lightning or bitcoin source: not with ${type}`);
    if (offer?.needs === "invite" && !str(params, "invite")?.trim()) throw new CliError("bad_request", `${type} needs --invite <fed11…>`);
    if (offer?.needs === "apiKey" && !str(params, "apiKey")?.trim()) throw new CliError("bad_request", `${type} on ${n} needs --api-key <key> (or api-key=… on --stdin)`);
    return;
  }
  // None offered on this network: the engine says why.
  const sources = nodeSources(offer);
  if (!sources?.length) return;
  if (!provider) throw new CliError("bad_request", `${type} needs --provider: one of ${sources.map((p) => p.id).join(", ")} (ghostly wallet list)`);
  const source = sources.find((p) => p.id === provider);
  if (!source) throw new CliError("bad_request", `No ${type} source ${JSON.stringify(provider)} on ${n} (ghostly wallet list)`);
  const unknown = Object.keys(values).find((name) => !source.fields.some((f) => f.name === name));
  if (unknown) throw new CliError("bad_request", `${provider} takes no --value ${unknown}: ${source.fields.length ? `its fields are ${source.fields.map((f) => f.name).join(", ")}` : "it has no fields"}`);
  const missing = source.fields.find((f) => !f.optional && !f.defaults?.[n] && !values[f.name]?.trim());
  if (missing) throw new CliError("bad_request", `${provider} needs --value ${missing.name}=<${missing.options?.map((o) => o.value).join("|") ?? missing.placeholder ?? missing.label.toLowerCase()}>`);
}

const network = (params: Params, fallback: WalletNetwork = "testnet") => oneOf(params, "network", NETWORKS, fallback);

/** `confirmedReal` for the engine: only when the caller confirmed real money, and only then. */
const real = (params: Params): { confirmedReal?: true } => (bool(params, "confirmReal") ? { confirmedReal: true } : {});

function netView(s: EngineState, n: WalletNetwork): NetworkWalletsView | undefined {
  return s.wallet.networks?.[n];
}

/** A Lightning card named by `card` on the network asked: one that is not there is not_found, before the engine is asked. */
function lightningCard(ctx: ApiContext, params: Params): void {
  const n = network(params), card = str(params, "card", true);
  if (!netView(state(ctx), n)?.lightnings?.some((c) => c.card === card)) throw new CliError("not_found", `No Lightning card ${JSON.stringify(card)} on ${n} (ghostly wallet list)`);
}

/**
 * The Lightning card `card` names, checked before the engine is asked: given with another type of wallet it is a usage
 * error, and one not on the network is not_found. Before, the engine dropped it for every type but Lightning, so a card
 * that named nothing removed the whole wallet of that type and the answer echoed the card as removed.
 */
function cardOf(ctx: ApiContext, params: Params, type: WalletType): string | undefined {
  const card = str(params, "card");
  if (card === undefined) return undefined;
  if (type !== "lightning") throw new CliError("usage", `--card names a Lightning card: not with ${type}`);
  lightningCard(ctx, params);
  return card;
}

/**
 * The engine opens the federations joined before in the background as it starts. A daemon has long done so when a call
 * comes; a one-shot command waits for them (at most 30 s) before its balances are read or money moves through one.
 */
async function federationsOpen(ctx: ApiContext, ms = 30_000): Promise<void> {
  if (ctx.mode !== "one-shot") return;
  const until = Date.now() + ms;
  const connecting = () => NETWORKS.some((n) => (netView(state(ctx), n)?.fedimint?.federations ?? []).some((f) => f.status === "connecting"));
  while (connecting() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 250));
}

/** One wallet of the deck with its balance, in its own unit. Never a key, a phrase or a token. */
export function walletJson(instance: WalletInstanceView, s: EngineState) {
  const view = netView(s, instance.network);
  let balance: number | string | null = null, unit = "sat", address: string | null = null, status: string | null = null, error: string | null = null;
  switch (instance.type) {
    case "cashu": balance = view?.balance ?? null; break;
    case "lightning": {
      const card = view?.lightnings?.find((c) => c.card === instance.card);
      balance = card?.balance ?? null; status = card?.status ?? null; error = card?.error ?? null;
      break;
    }
    case "arkade": balance = view?.ark?.balance ?? null; address = view?.ark?.address ?? null; error = view?.ark?.error ?? null; break;
    case "bark": balance = view?.bark?.balance ?? null; error = view?.bark?.error ?? null; break;
    case "spark": balance = view?.spark?.balance ?? null; address = view?.spark?.address ?? null; error = view?.spark?.error ?? null; break;
    case "bitcoin": balance = view?.bitcoin?.balance ?? null; address = view?.bitcoin?.address ?? null; status = view?.bitcoin?.status ?? null; error = view?.bitcoin?.error ?? null; break;
    case "fedimint": balance = view?.fedimint?.balance ?? null; error = view?.fedimint?.error ?? null; break;
    case "usdt": balance = view?.usdt?.balance ?? null; unit = "token-base"; address = view?.usdt?.address ?? null; error = view?.usdt?.error ?? null; break;
  }
  return {
    id: instance.id, type: instance.type, network: instance.network,
    ...(instance.card ? { card: instance.card, name: instance.name ?? null, receive: !!instance.receive } : {}),
    balance, unit, address, status, error, config: instance.config,
  };
}

export function paymentJson(p: PaymentView) {
  return {
    id: p.id, chat: p.linkId, kind: p.kind, direction: p.direction, amount: p.amount, unit: p.unit, memo: p.memo ?? null,
    state: p.state, error: p.error ?? null, network: paymentNetwork(p), method: p.target?.method ?? (p.federation || p.federations ? "fedimint" : p.invoice ? "lightning" : p.mint || p.mints ? "cashu" : null),
    createdAt: p.createdAt, ...(p.group ? { group: p.group } : {}), ...(p.closed ? { closed: true } : {}), ...(p.txid ? { txid: p.txid } : {}),
  };
}

/**
 * A Lightning invoice's network by its prefix (BOLT 11), for a hint only: test mints issue `lnbc` invoices too, so
 * the paying wallet's network is always named by the caller.
 */
export function invoiceNetwork(invoice: string): WalletNetwork | null {
  const lower = invoice.trim().toLowerCase().replace(/^lightning:/, "");
  if (!lower.startsWith("ln")) return null;
  if (/^lnbcrt/.test(lower)) return "testnet";
  if (/^lnbc\d|^lnbc1/.test(lower)) return "mainnet";
  return /^ln(tb|tbs|sb)/.test(lower) ? "testnet" : null;
}

const isInvoice = (text: string) => /^(lightning:)?ln(bc|tb|tbs|sb|bcrt)[0-9a-z]+$/i.test(text.trim());
const isLnurl = (text: string) => /^(lightning:)?lnurl[0-9a-z]+$/i.test(text.trim()) || /^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(text.trim());

/**
 * The engine refusing the mint URL the person typed (not a URL, or not https): their value, so `bad_request`, as
 * `service add` says; before, it was `engine` (exit 1), which a bot reads as the engine failing and may retry. Read by
 * its shape: the engine's `EngineError` carries `engineCode`.
 */
/** A payment's memo: the contact reads it as a message's text, so the secret guard of `send` holds (docs/CLI.md § Safety). */
function memoOf(params: Params, verb: string): string | undefined {
  const memo = str(params, "memo");
  if (memo && !bool(params, "force")) {
    const secret = findSecret(memo);
    if (secret) throw new CliError("confirm", `The memo looks like ${secret.kind === "cashu" ? "a Cashu token (money anyone who reads it can take)" : "a secret (a seed or a private key)"}; ${verb} with --force if you mean to`, { kind: secret.kind });
  }
  return memo || undefined;
}

function badMintUrl(error: unknown): boolean {
  const code = error instanceof Error ? (error as { engineCode?: unknown }).engineCode : undefined;
  return code === "invalidMintUrl" || code === "mintNotHttps";
}

/**
 * The engine's wallet refusals about what the person asked, by the words it writes (they carry no `engineCode`): a
 * wallet or card that is not there, a token or invoice that is not one, a wallet already made, no mint or source to do
 * it with. Before, each was `engine` (exit 1), which a bot reads as the engine failing and may retry.
 */
const WALLET_REFUSALS: [RegExp, ErrorCode][] = [
  [/^There is no .+ to remove$/, "not_found"],
  [/^That Lightning card is gone\b/, "not_found"],
  [/^That is not a (valid ecash token|Lightning invoice)$/, "bad_request"],
  [/^You already have a .+ wallet$/, "refused"],
  [/^No mint could create an invoice: No mint configured$/, "unavailable"],
  [/^No Bitcoin source is set up$/, "unavailable"],
  [/^The faucet did not pay: This wallet has no test mint\b/, "unavailable"],
  [/^Ghostly cannot ask this wallet's faucet by itself\b/, "unavailable"],
];

function walletRefusal(error: unknown): unknown {
  if (!(error instanceof Error) || error instanceof CliError) return error;
  const code = WALLET_REFUSALS.find(([pattern]) => pattern.test(error.message))?.[1];
  return code ? new CliError(code, error.message) : error;
}

const WALLETS: Record<string, Method> = {
  async "wallet.list"(ctx, params) {
    await federationsOpen(ctx);
    const s = state(ctx);
    const only = params.network === undefined ? null : network(params);
    const wallets = (s.wallet.wallets ?? []).filter((w) => !only || w.network === only).map((w) => walletJson(w, s));
    const offers = (s.wallet.offers ?? []).filter((o) => !only || o.network === only).map((o) => {
      const gap = NODE_GAPS[o.type];
      return { type: o.type, network: o.network, available: o.available && !gap, reason: gap ?? o.reason ?? null, exists: !!o.exists, several: !!o.several, needs: o.needs ?? null,
        ...(o.providers ? { providers: nodeSources(o)!.map((p) => ({ id: p.id, label: p.label, fields: p.fields.map((f) => ({ name: f.name, label: f.label, kind: f.kind, optional: !!f.optional })) })) } : {}) };
    });
    return { wallets, offers };
  },

  async "wallet.create"(ctx, params) {
    const type = oneOf(params, "type", TYPES, "cashu");
    const n = network(params);
    const gap = NODE_GAPS[type];
    if (gap) throw new CliError("unavailable", gap);
    // A Fedimint Lightning card needs its federation open.
    await federationsOpen(ctx);
    const values: Record<string, string> = {};
    const raw = params.values ?? {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.values(raw).some((v) => typeof v !== "string")) throw new CliError("bad_request", "values must be an object of strings");
    Object.assign(values, raw);
    // On-chain is BDK unless another source is named.
    const provider = str(params, "provider") ?? (type === "bitcoin" ? "bdk" : undefined);
    // BDK asks for a recovery phrase and makes a new wallet from one the app draws: here, one drawn now.
    if (type === "bitcoin" && provider === "bdk" && !values.mnemonic) values.mnemonic = generateMnemonic(wordlist, 128);
    createChecked(type, n, state(ctx).wallet.offers?.find((o) => o.type === type && o.network === n), provider, values, params);
    const made = await node(ctx).walletCreate({ type, network: n, ...(provider ? { providerId: provider } : {}), ...(Object.keys(values).length ? { values } : {}), ...(str(params, "invite") ? { invite: str(params, "invite") } : {}), ...(str(params, "apiKey") ? { apiKey: str(params, "apiKey") } : {}) });
    return walletJson(made, state(ctx));
  },

  async "wallet.remove"(ctx, params) {
    const type = oneOf(params, "type", TYPES, "cashu");
    const n = network(params);
    const card = cardOf(ctx, params, type);
    try {
      await node(ctx).walletRemove({ type, network: n, ...(card ? { card } : {}), ...(bool(params, "acceptLoss") ? { acceptLoss: true } : {}) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The engine keeps a wallet that holds money here, or that someone still pays into (#303): only the person decides.
      if (!bool(params, "acceptLoss") && /hold|still|awaiting|lose|backup/i.test(message)) throw new CliError("confirm", `${message} (pass acceptLoss, --accept-loss, only if that is intended)`);
      throw error;
    }
    return { removed: { type, network: n, card: card ?? null } };
  },

  async "wallet.faucet"(ctx, params) {
    const type = oneOf(params, "type", TYPES, "cashu");
    if (network(params) !== "testnet") throw new CliError("refused", "Test coins are for Testnet wallets only");
    const card = cardOf(ctx, params, type);
    return node(ctx).walletTestCoins({ type, network: "testnet", ...(card ? { card } : {}) });
  },

  async "wallet.history"(ctx, params) {
    const n = network(params);
    const limit = num(params, "limit", 50, { min: 1, max: 10_000, whole: true });
    await federationsOpen(ctx);
    return { network: n, history: (netView(state(ctx), n)?.history ?? []).slice(0, limit) };
  },

  async "wallet.receive"(ctx, params) {
    const amount = num(params, "amount", 0, { min: 1 });
    if (!amount) throw new CliError("bad_request", "amount is required");
    const n = network(params);
    await federationsOpen(ctx);
    const card = cardOf(ctx, params, "lightning");
    const invoice = await node(ctx).walletReceiveLightning({ amount, network: n, ...(card ? { card } : {}) });
    return { network: n, amount, invoice: invoice.invoice, expiresAt: invoice.expiresAt, paymentHash: invoice.paymentHash ?? null, source: invoice.source };
  },

  async "wallet.address"(ctx, params) {
    const type = oneOf(params, "type", ["bitcoin", "arkade", "spark", "usdt"] as const, "bitcoin");
    const n = network(params);
    if (type === "bitcoin") return { type, network: n, address: await node(ctx).bitcoinReceiveAddress({ network: n }) };
    const view = netView(state(ctx), n);
    const address = type === "arkade" ? view?.ark?.address : type === "spark" ? view?.spark?.address : view?.usdt?.address;
    if (!address) throw new CliError("unavailable", `No ${type} wallet with an address on ${n}`);
    return { type, network: n, address };
  },

  async "wallet.redeem"(ctx, params) {
    return node(ctx).walletReceiveToken({ token: str(params, "token", true).trim() });
  },

  async "wallet.mint.add"(ctx, params) {
    return node(ctx).walletAddMint({ url: str(params, "url", true), ...(bool(params, "primary") ? { primary: true } : {}) }).catch((error: unknown) => {
      throw badMintUrl(error) ? new CliError("bad_request", (error as Error).message) : error;
    });
  },

  async "lightning.default"(ctx, params) {
    lightningCard(ctx, params);
    await node(ctx).lightningSetReceive({ network: network(params), card: str(params, "card", true) });
    return { network: network(params), receive: str(params, "card", true) };
  },

  async "lightning.rename"(ctx, params) {
    lightningCard(ctx, params);
    await node(ctx).lightningRename({ network: network(params), card: str(params, "card", true), name: str(params, "name", true) });
    return { network: network(params), card: str(params, "card", true), name: str(params, "name", true) };
  },

  /** An invoice, a Lightning address or an LNURL, from the network's Lightning (a card of it, or its default). */
  async "pay"(ctx, params) {
    const text = str(params, "target", true).trim();
    const card = str(params, "card");
    let invoice = text.replace(/^lightning:/i, "");
    let n: WalletNetwork;
    let note: string | undefined;
    if (isInvoice(text)) {
      // Which wallet pays is named, never guessed from the invoice: test mints issue `lnbc` invoices too, and a
      // guess must never be what makes real money move. Testnet unless `network` says mainnet.
      n = network(params);
    } else if (isLnurl(text)) {
      n = network(params);
      const amount = num(params, "amount", 0, { min: 1 });
      if (!amount) throw new CliError("bad_request", "amount is required to pay a Lightning address or LNURL");
      const view = await node(ctx).lnurlResolve({ text, network: n });
      if (amount < view.minSat || amount > view.maxSat) throw new CliError("refused", `${view.domain} takes from ${view.minSat} to ${view.maxSat} sats`);
      const got = await node(ctx).lnurlInvoice({ id: view.id, amount, ...(str(params, "comment") ? { comment: str(params, "comment") } : {}), network: n });
      invoice = got.invoice; note = got.note;
    } else throw new CliError("bad_request", "Not a Lightning invoice, Lightning address or LNURL");
    if (n === "mainnet" && !bool(params, "confirmReal")) throw new CliError("confirm", "This pays real money (Mainnet): pass --confirm-real to confirm this payment");
    await federationsOpen(ctx);
    const quote =await node(ctx).walletQuoteInvoice({ invoice, network: n, ...(card ? { card } : {}) });
    const maxFee = params.maxFee === undefined ? null : num(params, "maxFee", 0);
    if (maxFee !== null && quote.feeReserve > maxFee) throw new CliError("refused", `The fee may reach ${quote.feeReserve} sats, more than the ${maxFee} allowed`);
    const paid = await node(ctx).walletPayQuote({ quote: quote.quote, mint: quote.mint, ...(note ? { note } : {}), ...real(params) });
    return { network: n, amount: quote.amount, feeReserve: quote.feeReserve, source: (quote as { source?: string }).source ?? quote.mint, paid: paid.paid };
  },

  /** Ecash to a contact in a chat (the payment sheet's Pay). */
  async "chat.pay"(ctx, params) {
    const memo = memoOf(params, "pay");
    const link = chatOf(ctx, params);
    inviteTaken(link);
    const amount = num(params, "amount", 0, { min: 1 });
    if (!amount) throw new CliError("bad_request", "amount is required");
    const n = network(params);
    if (n === "mainnet" && !bool(params, "confirmReal")) throw new CliError("confirm", "This pays real money (Mainnet): pass --confirm-real to confirm this payment");
    await federationsOpen(ctx);
    const { paymentId } = await node(ctx).sendPayment({ linkId: link.id, amount, timestamp: sentAt(), network: n, ...(memo ? { memo } : {}), ...real(params) });
    return { chat: link.id, paymentId };
  },

  /** A request in a chat (the payment sheet's Request): the contact's app pays it. */
  async "chat.request"(ctx, params) {
    const memo = memoOf(params, "request");
    const link = chatOf(ctx, params);
    const amount = num(params, "amount", 0, { min: 1 });
    if (!amount) throw new CliError("bad_request", "amount is required");
    const method = params.method === undefined ? undefined : oneOf(params, "method", METHODS, "cashu");
    const rail = params.rail === undefined ? undefined : oneOf(params, "rail", ["cashu", "lightning"] as const, "cashu");
    await federationsOpen(ctx);
    const { paymentId } = await node(ctx).requestPayment({
      linkId: link.id, amount, timestamp: sentAt(), network: network(params),
      ...(memo ? { memo } : {}), ...(method ? { method } : {}), ...(rail ? { rail } : {}), ...(str(params, "card") ? { card: str(params, "card") } : {}),
    });
    return { chat: link.id, paymentId };
  },

  /** Pays a request the contact made in a chat. */
  async "chat.payRequest"(ctx, params) {
    const link = chatOf(ctx, params);
    const paymentId = str(params, "payment", true);
    const request = state(ctx).payments[paymentId];
    if (!request || request.linkId !== link.id || request.kind !== "request") throw new CliError("not_found", `No request ${paymentId} in this chat`);
    // The request says which network it is paid on: real money or test coins, never the choice of the payer.
    const n = paymentNetwork(request);
    if (n === "mainnet" && !bool(params, "confirmReal")) throw new CliError("confirm", "This request is for real money (Mainnet): pass --confirm-real to confirm this payment", { network: n });
    const via = params.via === undefined ? undefined : oneOf(params, "via", ["lightning"] as const, "lightning");
    await federationsOpen(ctx);
    await node(ctx).payRequest({ linkId: link.id, paymentId, network: n, ...(via ? { via } : {}), ...(params.maxFee !== undefined ? { maxFee: num(params, "maxFee", 0) } : {}), ...(str(params, "card") ? { card: str(params, "card") } : {}), ...real(params) });
    return paymentJson(state(ctx).payments[paymentId] ?? request);
  },

  /** Which ways of paying this chat takes, per network (the chat's Accept switches). */
  async "chat.accept"(ctx, params) {
    const link = chatOf(ctx, params);
    const method = oneOf(params, "method", CHAT_METHODS, "cashu");
    const on = bool(params, "on");
    const nets = params.networks === undefined ? undefined : (() => {
      const value = params.networks;
      if (!Array.isArray(value) || !value.every((v) => v === "mainnet" || v === "testnet")) throw new CliError("bad_request", "networks must list mainnet and/or testnet");
      // An empty list names no network: the method would stay on while it is taken nowhere.
      if (value.length === 0) throw new CliError("bad_request", "networks must list mainnet and/or testnet: to stop taking it, --off");
      return value as WalletNetwork[];
    })();
    await node(ctx).setChatPaymentMethods({ linkId: link.id, methods: { [method]: on }, ...(nets ? { networks: { [method]: nets } } : {}) });
    const now = state(ctx).links.find((l) => l.id === link.id);
    return { chat: link.id, methods: now?.paymentMethods ?? null, networks: now?.paymentNetworks ?? null };
  },

  async "payment.list"(ctx, params) {
    const chat = params.chat === undefined ? null : chatOf(ctx, params).id;
    const payments = Object.values(state(ctx).payments).filter((p) => !chat || p.linkId === chat).sort((a, b) => b.createdAt - a.createdAt).map(paymentJson);
    return { payments };
  },

  async "payment.check"(ctx, params) {
    const link = chatOf(ctx, params);
    if (state(ctx).payments[str(params, "payment", true)]?.linkId !== link.id) throw new CliError("not_found", `No payment ${JSON.stringify(str(params, "payment", true))} in this chat (ghostly payment list --chat ${link.id})`);
    await node(ctx).checkPayment({ linkId: link.id, paymentId: str(params, "payment", true) });
    return { chat: link.id, paymentId: str(params, "payment", true) };
  },

  async "payment.reclaim"(ctx, params) {
    if (!state(ctx).payments[str(params, "payment", true)]) throw new CliError("not_found", `No payment ${JSON.stringify(str(params, "payment", true))} (ghostly payment list)`);
    await node(ctx).reclaimPayment({ paymentId: str(params, "payment", true) });
    const p = state(ctx).payments[str(params, "payment", true)];
    return p ? paymentJson(p) : { paymentId: str(params, "payment", true) };
  },
};

export const WALLET_METHODS: Record<string, Method> = Object.fromEntries(Object.entries(WALLETS).map(([name, method]) => [name,
  (ctx: ApiContext, params: Params) => method(ctx, params).catch((error: unknown) => { throw walletRefusal(error); })]));

export type { ApiContext };
