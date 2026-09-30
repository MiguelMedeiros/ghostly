#!/usr/bin/env node
// An echo bot on the daemon's socket, no dependencies: subscribe to events, answer each message.
// Run `ghostly daemon --detach` first. GHOSTLY_SOCKET names its socket (`ghostly daemon status` prints it); left
// out, the bot asks.
import { execFileSync } from "node:child_process";
import { connect } from "node:net";
import { createInterface } from "node:readline";

// GHOSTLY_SOCKET, else the socket `ghostly daemon status` names: where it is depends on GHOSTLY_HOME, the profile
// (--profile or GHOSTLY_PROFILE) and the path's length, so it is asked, never guessed.
const socket = connect(process.env.GHOSTLY_SOCKET ?? JSON.parse(execFileSync("ghostly", ["daemon", "status"], { encoding: "utf8" })).socket);
let nextId = 1;
const call = (method, params) => socket.write(JSON.stringify({ id: nextId++, method, params }) + "\n");

createInterface({ input: socket }).on("line", (line) => {
  const { event, error } = JSON.parse(line);
  if (error) console.error(error.code, error.message);
  if (event?.type !== "message.received") return;
  call("chat.send", { chat: event.chat, text: `echo: ${event.message.text}` });
});
call("events.subscribe", {});
