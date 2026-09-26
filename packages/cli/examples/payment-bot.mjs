#!/usr/bin/env node
// A payment bot on the daemon's socket, Testnet only, no dependencies:
//   "request 21"  -> the bot asks you for 21 test sats (a request in the chat; your app pays it)
//   "tip 5"       -> the bot sends you 5 test sats of ecash
//   "balance"     -> the bot says what its Testnet Cashu wallet holds
// and it thanks you when a request of its own is settled.
//
// Before: ghostly wallet create cashu && ghostly wallet faucet cashu && ghostly daemon --detach
// GHOSTLY_SOCKET is the daemon's socket (`ghostly daemon status` prints it).
import { connect } from "node:net";
import { createInterface } from "node:readline";

const socket = connect(process.env.GHOSTLY_SOCKET ?? `${process.env.HOME}/.ghostly/profiles/default/daemon.sock`);
let nextId = 1;
const waiting = new Map();
function call(method, params) {
  const id = nextId++;
  socket.write(JSON.stringify({ id, method, params }) + "\n");
  return new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
}
const say = (chat, text) => call("chat.send", { chat, text }).catch((error) => console.error("send:", error.message));

createInterface({ input: socket }).on("line", async (line) => {
  const message = JSON.parse(line);
  if (message.id !== undefined && waiting.has(message.id)) {
    const { resolve, reject } = waiting.get(message.id);
    waiting.delete(message.id);
    if (message.error) reject(new Error(`${message.error.code}: ${message.error.message}`)); else resolve(message.result);
    return;
  }
  const event = message.event;
  if (!event) return;
  try {
    if (event.type === "message.received") {
      const text = event.message.text.trim().toLowerCase();
      const amount = Number(/^(?:request|tip) (\d{1,6})$/.exec(text)?.[1]);
      if (text.startsWith("request ") && amount > 0) {
        // Testnet: the network is named on every call; this bot never touches real money.
        await call("chat.request", { chat: event.chat, amount, memo: "for the payment bot", network: "testnet" });
      } else if (text.startsWith("tip ") && amount > 0) {
        await call("chat.pay", { chat: event.chat, amount, memo: "a tip from the bot", network: "testnet" });
      } else if (text === "balance") {
        const { wallets } = await call("wallet.list", { network: "testnet" });
        const cashu = wallets.find((w) => w.type === "cashu");
        await say(event.chat, cashu ? `I hold ${cashu.balance} test sats.` : "I have no Testnet Cashu wallet yet.");
      }
    } else if (event.type === "payment.updated" && event.payment.kind === "request" && event.payment.direction === "out" && event.payment.state === "settled") {
      await say(event.chat, `Thanks: ${event.payment.amount} test sats received.`);
    }
  } catch (error) {
    await say(event.chat, `Sorry, that did not work (${error.message}).`);
  }
});

socket.on("error", (error) => { console.error("Cannot reach the daemon:", error.message); process.exit(1); });
call("events.subscribe", {});
