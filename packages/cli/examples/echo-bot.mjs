#!/usr/bin/env node
// An echo bot on the daemon's socket, no dependencies: subscribe to events, answer each message.
// Run `ghostly daemon --detach` first; GHOSTLY_SOCKET is its socket (`ghostly daemon status` prints it).
import { connect } from "node:net";
import { createInterface } from "node:readline";

const socket = connect(process.env.GHOSTLY_SOCKET ?? `${process.env.HOME}/.ghostly/profiles/default/daemon.sock`);
let nextId = 1;
const call = (method, params) => socket.write(JSON.stringify({ id: nextId++, method, params }) + "\n");

createInterface({ input: socket }).on("line", (line) => {
  const { event, error } = JSON.parse(line);
  if (error) console.error(error.code, error.message);
  if (event?.type !== "message.received") return;
  call("chat.send", { chat: event.chat, text: `echo: ${event.message.text}` });
});
call("events.subscribe", {});
