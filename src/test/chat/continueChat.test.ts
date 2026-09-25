import { describe, expect, it } from "vitest";
import { createLink, decodeInviteCode, encodeInviteCode } from "@ghostly/core";
import { continueInNewChat } from "../../lib/continueChat";
import { ensureSession, getInviteCode, loadSession } from "../../lib/storage";

// covers: chat.compat

describe("a compatibility chat continues in a new chat (WISP 402)", () => {
  it("makes a new chat, remembers it on the old one, and says it with a link a v0.4 app cannot open", async () => {
    const { mine } = createLink();
    const old = ensureSession({ seedB64: mine.seedB64, peerPubKeyB64: mine.peerPubKeyZ32, encKeyB64: mine.encKeyB64 });
    const next = (await continueInNewChat(old, "https://app.ghostly.tools"))!;
    expect(next.sessionId).not.toBe(old);
    expect(loadSession(old)?.continuedIn).toBe(next.sessionId);
    expect(loadSession(next.sessionId)?.profile).toBe("paired-chat/1");
    const code = getInviteCode(next.sessionId)!;
    expect(next.message).toContain(`https://app.ghostly.tools/#/chat/${code}`);
    // The link opens the new chat in a current app…
    expect(decodeInviteCode(next.message.slice(next.message.indexOf("https://")))).toMatchObject({ profile: "paired-chat/1" });
    // …and a v0.4 app, which reads only three parts, finds nothing it can open.
    expect(code.replace(/^.*#/, "").replace(/^\/?chat\//, "").split("/")).not.toHaveLength(3);
    expect(new TextEncoder().encode(next.message).length, "fits a v0.4 DHT text").toBeLessThanOrEqual(500);
  });

  it("is only for compatibility chats", async () => {
    const { mine, invite } = createLink();
    const paired = ensureSession({ seedB64: mine.seedB64, peerPubKeyB64: mine.peerPubKeyZ32, encKeyB64: mine.encKeyB64, profile: "paired-chat/1" },
      { inviteCode: encodeInviteCode({ ...invite, profile: "paired-chat/1" }) });
    expect(await continueInNewChat(paired)).toBeNull();
    expect(await continueInNewChat("nope")).toBeNull();
  });
});
