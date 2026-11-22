import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { developers } from "../content/developers.ts";

// /developers shows the CLI twice: in the availability table (content/developers.ts) and on the architecture board
// (lib/composition.ts: its blocks and the "headless CLI" preset). The board's file imports JSON, so it is read as text.
const board = readFileSync(new URL("../lib/composition.ts", import.meta.url), "utf8");
const block = (id) => new RegExp(`b\\("${id}",[^\\n]*`).exec(board)?.[0] ?? assert.fail(`no block "${id}"`);
const cliPreset = /id: "cli",[\s\S]*?blurb: "([^"]*)"/.exec(board)?.[1] ?? assert.fail("no cli preset");
const { clients, rows } = developers.availability;
const onCli = (name) => {
  const row = rows.find((r) => r.name.startsWith(name)) ?? assert.fail(`no row "${name}"`);
  return row.cells[clients.indexOf("CLI")] !== null;
};

test("the CLI preset says what the table says about calls", () => {
  assert.ok(onCli("Voice calls"));
  assert.doesNotMatch(cliPreset, /\bno calls\b/i);
});

test("the groups block names the CLI when the table lists groups on it", () => {
  assert.ok(onCli("Private groups"));
  assert.match(block("groups"), /\bCLI\b/);
});

test("the core block does not send the CLI through the relays alone when the table says it reads the DHT", () => {
  assert.ok(onCli("Mainline DHT read directly"));
  assert.doesNotMatch(block("core"), /CLI go through Pkarr relays/);
});
