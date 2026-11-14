import { describe, expect, it } from "vitest";
import { COMMANDS } from "../src/commands";
import { LOCAL_SETTINGS, offlineCall, readOnly } from "../src/main";
// covers: headless.cli

/**
 * Every table command is named here once: one that only reads what the profile stores, changes only this device, or
 * says something on a live session only opens it offline as a one-shot, any other online. A new command fails here
 * until it is put in one of the four, so nothing goes online by default (eight reads did: 3 relay PUTs and 2 GETs
 * each, 3.3 s with a relay that takes 1.5 s).
 */
const READS = [
  "events", "status", "chat history", "chat list", "chat show", "message details", "group history", "group list", "group show",
  "file list", "payment list", "wallet history", "wallet list", "identity contact", "identity list", "identity providers",
  "service list", "service peer", "call auto", "group auto", "chat accept", "call list", "app served", "x401 credential list", "saved list", "status show",
];
/**
 * Changes that stay on this device: no contact and no relay hears of them. This profile's status too: no relay carries
 * it, and only a live session says it (a one-shot waits for none; the daemon, or the profile's next run online, does).
 * An app served or unserved too: served.json, read when the profile next starts.
 */
const LOCAL_WRITES = [
  "app serve", "app unserve", "chat remove", "chat rename", "identity cancel", "saved add", "saved remove", "service add", "status clear", "status set",
  "x401 credential add", "x401 credential remove", "x401 key new",
];
/**
 * Said on a live session only: a one-shot starts the chat or group as it says it, so it reaches nobody (it waited for
 * the relays all the same). Offline unless `--for` waits for the chat to be live.
 */
const LIVE_ONLY = ["group typing", "typing"];
/**
 * Done only by a daemon: a one-shot refuses them whatever the network says ("start `ghostly daemon --detach`"), so it
 * opens offline. Online it waited for the relays first: 10 s to say so with a relay that does not answer.
 */
const DAEMON_ONLY = ["app close", "app open", "app send", "call answer", "call flush", "call start", "service close", "service open"];
const ONLINE = [
  "profile picture",
  "button press", "button update", "chat connect", "chat disconnect", "chat transport", "chat verify", "chat wait",
  "forward", "invite create", "invite join", "message delete", "message retry", "pin", "react", "routine send", "routine update", "task send",
  "task update", "usage send",
  "group accept", "group admin", "group create", "group decline", "group forget", "group hub", "group invite", "group join", "group leave",
  "group link", "group picture", "group react", "group remove", "group rename", "group rotate",
  "file accept", "file cancel", "file decline", "file pause", "file request", "file resend", "file resume", "file save", "file send", "file wait",
  "chat pay", "chat pay-request", "chat request", "lightning default", "lightning rename", "pay", "payment check", "payment reclaim",
  "wallet add-mint", "wallet address", "wallet create", "wallet faucet", "wallet receive", "wallet redeem", "wallet remove",
  "identity complete", "identity recheck", "identity remove", "identity share", "identity withdraw",
  "service enable", "service remove", "service share",
  // A one-shot online may see a call ring, and decline it.
  "call hangup",
];

describe("which one-shots open the profile offline", () => {
  const table = Object.entries(COMMANDS).filter(([, c]) => !c.run);

  it("names every table command once, as a read, a change of this device, live only, daemon only or none of them", () => {
    expect([...READS, ...LOCAL_WRITES, ...LIVE_ONLY, ...DAEMON_ONLY, ...ONLINE].sort()).toEqual(table.map(([name]) => name).sort());
  });

  it("opens the reads, this device's changes and what only a daemon does offline, and the others online", () => {
    for (const [name, c] of table) {
      expect(readOnly(c.method, {}), name).toBe(READS.includes(name));
      expect(offlineCall(c.method, {}), name).toBe(READS.includes(name) || LOCAL_WRITES.includes(name) || LIVE_ONLY.includes(name) || DAEMON_ONLY.includes(name));
    }
  });

  it("opens typing offline, and online with --for: that one waits for the chat or group to be live", () => {
    for (const method of ["chat.typing", "group.typing"]) {
      expect(offlineCall(method, { chat: "bob", stop: true }), method).toBe(true);
      expect(offlineCall(method, { chat: "bob", for: 30 }), method).toBe(false);
      expect(readOnly(method, {}), method).toBe(false);
    }
  });

  it("opens call auto offline when it turns auto-answer on or off: calls.json is this device's", () => {
    expect(readOnly("call.auto", { on: true, from: ["bob"] })).toBe(false);
    expect(offlineCall("call.auto", { on: true, from: ["bob"] })).toBe(true);
    expect(offlineCall("call.auto", { on: false })).toBe(true);
  });

  it("opens group auto offline when it turns auto-join on or off: groups.json is this device's, and only a daemon accepts", () => {
    expect(readOnly("group.auto", { on: true, from: ["bob"] })).toBe(false);
    expect(offlineCall("group.auto", { on: true, from: ["bob"] })).toBe(true);
    expect(offlineCall("group.auto", { on: false })).toBe(true);
  });

  it("opens chat accept offline only when it names no method: then it says what the chat takes", () => {
    expect(readOnly("chat.accept", { chat: "bob" })).toBe(true);
    expect(readOnly("chat.accept", { chat: "bob", method: "cashu", on: false })).toBe(false);
    expect(offlineCall("chat.accept", { chat: "bob", method: "cashu", on: true, networks: ["testnet"] })).toBe(false);
  });

  it("sets this device's own settings offline, and those the contacts or the relays see online", () => {
    expect([...LOCAL_SETTINGS].sort()).toEqual(["autoDownloads", "daemonPresence", "sendTyping", "serveFiles"]);
    for (const key of ["nick", "shareProfile", "online", "relays", "irohRelays", "hyperdhtRelay", "iceServers", "publicProfiles"]) {
      expect(LOCAL_SETTINGS.has(key), key).toBe(false);
    }
  });
});
