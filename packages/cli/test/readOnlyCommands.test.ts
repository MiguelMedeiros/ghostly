import { describe, expect, it } from "vitest";
import { COMMANDS } from "../src/commands";
import { readOnly } from "../src/main";
// covers: headless.cli

/**
 * Every table command is named here once: one that only reads what the profile stores opens it offline as a one-shot,
 * any other online. A new command fails here until it is put in one of the two, so a read never goes online by default
 * (eight did: 3 relay PUTs and 2 GETs each, 3.3 s with a relay that takes 1.5 s).
 */
const READS = [
  "events", "status", "chat history", "chat list", "chat show", "message details", "group history", "group list", "group show",
  "file list", "payment list", "wallet history", "wallet list", "identity contact", "identity list", "identity providers",
  "service list", "service peer", "call auto", "call list", "app served",
];
const ONLINE = [
  "profile picture",
  "button press", "button update", "chat connect", "chat disconnect", "chat remove", "chat rename", "chat transport", "chat verify", "chat wait",
  "forward", "invite create", "invite join", "message delete", "message retry", "pin", "react", "routine send", "routine update", "task send",
  "task update", "typing", "usage send",
  "group accept", "group admin", "group create", "group decline", "group forget", "group hub", "group invite", "group join", "group leave",
  "group link", "group picture", "group react", "group remove", "group rename", "group rotate", "group typing",
  "file accept", "file cancel", "file decline", "file pause", "file request", "file resend", "file resume", "file save", "file send", "file wait",
  "chat accept", "chat pay", "chat pay-request", "chat request", "lightning default", "lightning rename", "pay", "payment check", "payment reclaim",
  "wallet add-mint", "wallet address", "wallet create", "wallet faucet", "wallet receive", "wallet redeem", "wallet remove",
  "identity cancel", "identity complete", "identity recheck", "identity remove", "identity share", "identity withdraw",
  "service add", "service close", "service enable", "service open", "service remove", "service share",
  "call answer", "call flush", "call hangup", "call start",
  "app close", "app open", "app send", "app serve", "app unserve",
];

describe("which one-shots open the profile offline", () => {
  const table = Object.entries(COMMANDS).filter(([, c]) => !c.run);

  it("names every table command once, as a read or not", () => {
    expect([...READS, ...ONLINE].sort()).toEqual(table.map(([name]) => name).sort());
  });

  it("opens the reads offline and the others online", () => {
    for (const [name, c] of table) expect(readOnly(c.method, {}), name).toBe(READS.includes(name));
  });

  it("opens call auto online when it turns auto-answer on or off", () => {
    expect(readOnly("call.auto", { on: true, from: ["bob"] })).toBe(false);
    expect(readOnly("call.auto", { on: false })).toBe(false);
  });
});
