import { describe, expect, it } from "vitest";
import { nameInChat, nameToldIn } from "../../lib/apps/nameInChat";
import { engineState, fakeEngine, linkView } from "../fakeEngine";

// covers: apps.web-sandbox, apps.desktop-sandbox

/**
 * The name an app granted `name` reads in a chat (WISP 1200 § Permissions): the one this profile tells that chat's
 * contact, as the contact's app shows it, and none whenever the contact may not have it.
 */
const LINK = "link-1";
/** Ana's chat, where both sides said their names. */
const chat = linkView({ id: LINK, profile: "paired-chat/1", peerNick: "Ana" });
const profile = (settings: { nick?: string; shareProfile?: boolean } = {}, links = [chat]) => engineState({ settings: { nick: "Bia", ...settings }, links });

describe("the person's name in a chat, for an app", () => {
  it("is the name the profile tells its contacts", () => {
    expect(nameToldIn(profile(), LINK)).toBe("Bia");
    // Sharing switched on again is kept as no setting at all.
    expect(nameToldIn(profile({ shareProfile: true }), LINK)).toBe("Bia");
  });

  it("is none while the profile does not share its name, or has none", () => {
    expect(nameToldIn(profile({ shareProfile: false }), LINK)).toBeUndefined();
    expect(nameToldIn(profile({ nick: "" }), LINK)).toBeUndefined();
    expect(nameToldIn(null, LINK)).toBeUndefined();
  });

  it("is the name as the contact's app keeps it: no hidden characters, 64 at most, none when nothing is left", () => {
    expect(nameToldIn(profile({ nick: "  Bia\u202e \u200b" }), LINK)).toBe("Bia");
    expect(nameToldIn(profile({ nick: "b".repeat(80) }), LINK)).toBe("b".repeat(64));
    expect(nameToldIn(profile({ nick: " \u200b\n" }), LINK)).toBeUndefined();
  });

  it("is none where the contact may not have it: another chat, a chat that is not paired, a contact never heard from", () => {
    expect(nameToldIn(profile(), "link-2")).toBeUndefined();
    expect(nameToldIn(profile({}, [linkView({ id: LINK, peerNick: "Ana" })]), LINK)).toBeUndefined();
    expect(nameToldIn(profile({}, [linkView({ id: LINK, profile: "paired-chat/1" })]), LINK)).toBeUndefined();
    // A contact that said it has no name was heard from all the same.
    expect(nameToldIn(profile({}, [linkView({ id: LINK, profile: "paired-chat/1", peerNick: "" })]), LINK)).toBe("Bia");
  });

  it("stays the profile's own name when an identity is shared in the chat", () => {
    const shared = linkView({ id: LINK, profile: "paired-chat/1", peerNick: "Ana", identities: { support: true, shared: [{ id: "proof-1", status: "accepted" }], received: [] } as never });
    expect(nameToldIn(profile({}, [shared]), LINK)).toBe("Bia");
  });

  it("reads the engine's state, as the openers are given it", () => {
    fakeEngine.setState(profile());
    expect(nameInChat(LINK)).toBe("Bia");
    fakeEngine.setState(profile({ shareProfile: false }));
    expect(nameInChat(LINK)).toBeUndefined();
  });
});
