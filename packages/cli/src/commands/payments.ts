import { type Command, net, card, memo, confirmReal, sats, pairs } from "./shared";

/** Wallets and payments: one entry per command, in alphabetical order (test/commands.test.ts checks). */
export const commands: Record<string, Command> = {
  "chat accept": {
    method: "chat.accept", usage: "chat accept <chat> <method> [--off] [--networks mainnet,testnet]", summary: "Which ways of paying a chat takes",
    args: ["chat", "method"], options: { off: { type: "boolean", description: "Stop taking it" }, networks: { type: "string", description: "Comma-separated networks it is taken on" } },
    params: ({ options }, a) => ({ chat: a.chat, method: a.method, on: options.off !== true, networks: typeof options.networks === "string" ? options.networks.split(",").map((n) => n.trim()).filter(Boolean) : undefined }),
  },
  "chat pay": {
    method: "chat.pay", usage: "chat pay <chat> <sats> [--memo t] [--network testnet] [--confirm-real]", summary: "Send ecash to a contact (Mainnet needs --confirm-real)",
    args: ["chat", "amount"], options: { memo, network: net, "confirm-real": confirmReal },
    params: ({ options }, a) => ({ chat: a.chat, amount: sats(a.amount), memo: options.memo, network: options.network, confirmReal: options["confirm-real"] === true }),
  },
  "chat pay-request": {
    method: "chat.payRequest", usage: "chat pay-request <chat> <payment> [--via lightning] [--max-fee sats] [--card <id>] [--confirm-real]", summary: "Pay a contact's request",
    args: ["chat", "payment"], options: { via: { type: "string", description: "lightning: pay its invoice instead of ecash" }, "max-fee": { type: "number", description: "Refuse a fee above this" }, card, "confirm-real": confirmReal },
    params: ({ options }, a) => ({ chat: a.chat, payment: a.payment, via: options.via, maxFee: options["max-fee"], card: options.card, confirmReal: options["confirm-real"] === true }),
  },
  "chat request": {
    method: "chat.request", usage: "chat request <chat> <sats> [--memo t] [--method m] [--rail cashu|lightning] [--network testnet] [--card <id>]", summary: "Ask a contact to pay",
    args: ["chat", "amount"], options: { memo, method: { type: "string", description: "cashu, arkade, usdt, bitcoin, spark, …" }, rail: { type: "string", description: "cashu or lightning" }, network: net, card },
    params: ({ options }, a) => ({ chat: a.chat, amount: sats(a.amount), memo: options.memo, method: options.method, rail: options.rail, network: options.network, card: options.card }),
  },
  "lightning default": { method: "lightning.default", usage: "lightning default <card> [--network testnet]", summary: "The Lightning card that receives by default", args: ["card"], options: { network: net }, params: ({ options }, { card: c }) => ({ card: c, network: options.network }) },
  "lightning rename": { method: "lightning.rename", usage: "lightning rename <card> <name...> [--network testnet]", summary: "Name a Lightning card", args: ["card", "name..."], options: { network: net }, params: ({ options }, a) => ({ card: a.card, name: a.name, network: options.network }) },
  "pay": {
    method: "pay", usage: "pay <invoice|lightning-address|lnurl> [--amount sats] [--network n] [--max-fee sats] [--card <id>] [--comment t] [--confirm-real]", summary: "Pay over Lightning from Testnet, or --network mainnet with --confirm-real",
    args: ["target"], options: { amount: { type: "number", description: "Sats, for an address or LNURL" }, network: net, "max-fee": { type: "number", description: "Refuse a fee above this" }, card, comment: { type: "string", description: "For the address's owner" }, "confirm-real": confirmReal },
    params: ({ options }, { target }) => ({ target, amount: options.amount, network: options.network, maxFee: options["max-fee"], card: options.card, comment: options.comment, confirmReal: options["confirm-real"] === true }),
  },
  "payment check": { method: "payment.check", usage: "payment check <chat> <payment>", summary: "Paid from another wallet: the contact's app looks now", args: ["chat", "payment"], params: (_, a) => ({ chat: a.chat, payment: a.payment }) },
  "payment list": { method: "payment.list", usage: "payment list [--chat <chat>]", summary: "Payments and requests, newest first", options: { chat: { type: "string", description: "Only this chat's" } }, params: ({ options }) => ({ chat: options.chat }) },
  "payment reclaim": { method: "payment.reclaim", usage: "payment reclaim <payment>", summary: "Take back ecash the contact has not taken", args: ["payment"], params: (_, a) => ({ payment: a.payment }) },
  "wallet add-mint": {
    method: "wallet.mint.add", usage: "wallet add-mint <url> [--primary]", summary: "Add a Cashu mint (a local or test mint is Testnet's)",
    args: ["url"], options: { primary: { type: "boolean", description: "Make it the one invoices are created at" } }, params: ({ options }, { url }) => ({ url, primary: options.primary === true }),
  },
  "wallet address": {
    method: "wallet.address", usage: "wallet address <bitcoin|arkade|spark|usdt> [--network testnet]", summary: "An address to be paid on",
    args: ["type"], options: { network: net }, params: ({ options }, { type }) => ({ type, network: options.network }),
  },
  "wallet create": {
    method: "wallet.create", usage: "wallet create <type> [--network testnet] [--provider <id>] [--value name=value]... [--invite <code>] [--api-key <key>]", summary: "A wallet: cashu, lightning, arkade, spark, bitcoin, usdt (bark, fedimint: app only)",
    args: ["type"], options: { network: net, provider: { type: "string", description: "Lightning or on-chain source (wallet list shows them)" }, value: { type: "list", description: "A field of the source's form, name=value" }, invite: { type: "string", description: "Fedimint: the federation's invite" }, "api-key": { type: "string", description: "Spark on Mainnet: your Breez API key" } },
    params: ({ options }, { type }) => ({ type, network: options.network, provider: options.provider, invite: options.invite, apiKey: options["api-key"], values: pairs(options.value) }),
  },
  "wallet faucet": {
    method: "wallet.faucet", usage: "wallet faucet <type> [--card <id>]", summary: "Test coins from a Testnet wallet's faucet",
    args: ["type"], options: { card }, params: ({ options }, { type }) => ({ type, network: "testnet", card: options.card }),
  },
  "wallet history": {
    method: "wallet.history", usage: "wallet history [--network testnet] [--limit n]", summary: "A network's wallet history, newest first",
    options: { network: net, limit: { type: "number", description: "Entries (default 50)" } }, params: ({ options }) => ({ network: options.network, limit: options.limit }),
  },
  "wallet list": {
    method: "wallet.list", usage: "wallet list [--network mainnet|testnet]", summary: "Wallets with their balances, and what New can make",
    options: { network: net }, params: ({ options }) => ({ network: options.network }),
  },
  "wallet receive": {
    method: "wallet.receive", usage: "wallet receive <sats> [--network testnet] [--card <id>]", summary: "A Lightning invoice to be paid",
    args: ["amount"], options: { network: net, card }, params: ({ options }, { amount }) => ({ amount: sats(amount), network: options.network, card: options.card }),
  },
  "wallet redeem": { method: "wallet.redeem", usage: "wallet redeem <cashu-token>", summary: "Take the ecash of a Cashu token (its mint must be one of yours)", args: ["token"], params: (_, { token }) => ({ token }) },
  "wallet remove": {
    method: "wallet.remove", usage: "wallet remove <type> [--network testnet] [--card <id>] [--accept-loss]", summary: "Remove a wallet; refused while it holds money or waits for some, unless --accept-loss",
    args: ["type"], options: { network: net, card: card, "accept-loss": { type: "boolean", description: "What it holds on this device is lost without its backup" } },
    params: ({ options }, { type }) => ({ type, network: options.network, card: options.card, acceptLoss: options["accept-loss"] === true }),
  },
};
