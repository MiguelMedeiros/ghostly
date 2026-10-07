import { describe, expect, it } from "vitest";
import en from "../../locales/en";
import { translateWith } from "../../locales/translate";
import { appsBlock, appsComposerHint } from "../../lib/apps/availability";
import type { PeerLinkState } from "../../lib/platform";
// covers: apps.chat.card

/*
 * Why + → Apps cannot reach the same app on the contact's side (WISP 1200 § In a chat): not live yet, or a contact whose
 * app never offers apps/1 (an older Ghostly such as 1.1, or one with apps off). Only the first is about being online.
 */
const t = translateWith(en);
const peer = (live: boolean, peerOffers: string[] | null): PeerLinkState => ({
  pairing: live ? { status: "ready" } : { status: "waiting" },
  dataLink: live ? "open" : "idle",
  sessionOffers: { mine: ["apps/1", "calls/1"], peer: peerOffers },
}) as unknown as PeerLinkState;

describe("+ → Apps", () => {
  it("says nothing when both offer apps/1 on a live chat", () => {
    expect(appsBlock(peer(true, ["apps/1"]))).toBeNull();
    expect(appsComposerHint(peer(true, ["apps/1"]), "Olga", t)).toBeNull();
  });

  it("asks for you both online while the chat is not live", () => {
    expect(appsComposerHint(peer(false, null), "Olga", t)).toBe("Apps need you both online");
    expect(appsComposerHint(peer(false, ["apps/1"]), "Olga", t)).toBe("Apps need you both online");
  });

  it("names a live contact whose app offers no apps/1 (an older Ghostly), rather than asking them to come online", () => {
    expect(appsBlock(peer(true, ["calls/1", "files/3"]))).toBe("contact-cannot");
    expect(appsComposerHint(peer(true, ["calls/1", "files/3"]), "Olga", t)).toBe("Olga's app can't run apps yet");
    expect(appsComposerHint(peer(true, null), "Olga", t)).toBe("Olga's app can't run apps yet");
  });

  it("says nothing in a chat whose own app does not offer apps/1", () => {
    expect(appsComposerHint({ ...peer(true, []), sessionOffers: { mine: ["calls/1"], peer: [] } } as PeerLinkState, "Olga", t)).toBeNull();
  });
});
