import { describe, expect, it } from "vitest";
import { COMMANDS } from "../src/commands";
import { LOCAL_SETTINGS, offlineCall, readOnly } from "../src/main";
// covers: headless.cli

/**
 * Every table command is named here once: one that only reads what the profile stores, or changes only this device,
 * opens it offline as a one-shot, any other online. A new command fails here until it is put in one of the three, so
 * nothing goes online by default (eight reads did: 3 relay PUTs and 2 GETs each, 3.3 s with a relay that takes 1.5 s).
 */
const READS = [
  "events", "status", "chat history", "chat list", "chat show", "message details", "group history", "group list", "group show",
  "file list", "payment list", "wallet history", "wallet list", "identity contact", "identity list", "identity providers",
  "service list", "service peer", "call auto", "call list", "app served", "x401 credential list", "contact-link show",
];
/** Changes that stay on this device: no contact and no relay hears of them. */
const LOCAL_WRITES = ["chat remove", "chat rename", "identity cancel", "service add", "x401 credential add", "x401 credential remove", "x401 key new", "requests decline"];
const ONLINE = [
  "profile picture",
  "button press", "button update", "chat connect", "chat disconnect", "chat transport", "chat verify", "chat wait",
  "forward", "invite create", "invite join", "message delete", "message retry", "pin", "react", "routine send", "routine update", "task send",
  "task update", "typing", "usage send",
  "group accept", "group admin", "group create", "group decline", "group forget", "group hub", "group invite", "group join", "group leave",
  "group link", "group picture", "group react", "group remove", "group rename", "group rotate", "group typing",
  "file accept", "file cancel", "file decline", "file pause", "file request", "file resend", "file resume", "file save", "file send", "file wait",
  "chat accept", "chat pay", "chat pay-request", "chat request", "lightning default", "lightning rename", "pay", "payment check", "payment reclaim",
  "wallet add-mint", "wallet address", "wallet create", "wallet faucet", "wallet receive", "wallet redeem", "wallet remove",
  "identity complete", "identity recheck", "identity remove", "identity share", "identity withdraw",
  "service close", "service enable", "service open", "service remove", "service share",
  "call answer", "call flush", "call hangup", "call start",
  "app close", "app open", "app send", "app serve", "app unserve",
  "contact-link create", "contact-link off", "requests accept", "requests list",
];

describe("which one-shots open the profile offline", () => {
  const table = Object.entries(COMMANDS).filter(([, c]) => !c.run);

  it("names every table command once, as a read, a change of this device or neither", () => {
    expect([...READS, ...LOCAL_WRITES, ...ONLINE].sort()).toEqual(table.map(([name]) => name).sort());
  });

  it("opens the reads and this device's changes offline, and the others online", () => {
    for (const [name, c] of table) {
      expect(readOnly(c.method, {}), name).toBe(READS.includes(name));
      expect(offlineCall(c.method, {}), name).toBe(READS.includes(name) || LOCAL_WRITES.includes(name));
    }
  });

  it("opens call auto offline when it turns auto-answer on or off: calls.json is this device's", () => {
    expect(readOnly("call.auto", { on: true, from: ["bob"] })).toBe(false);
    expect(offlineCall("call.auto", { on: true, from: ["bob"] })).toBe(true);
    expect(offlineCall("call.auto", { on: false })).toBe(true);
  });

  it("sets this device's own settings offline, and those the contacts or the relays see online", () => {
    expect([...LOCAL_SETTINGS].sort()).toEqual(["autoDownloads", "sendTyping", "serveFiles"]);
    for (const key of ["nick", "shareProfile", "online", "relays", "irohRelays", "hyperdhtRelay", "readRelays", "iceServers", "publicProfiles"]) {
      expect(LOCAL_SETTINGS.has(key), key).toBe(false);
    }
  });
});
