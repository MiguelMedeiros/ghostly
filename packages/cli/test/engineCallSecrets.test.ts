import { describe, expect, it } from "vitest";
import type { EngineState } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
// covers: headless.engine-passthrough

/**
 * `engine.call` over the socket keeps to README § Secrets as `ghostly engine` does: a call that answers with secrets is
 * refused without `showSecret`, and `getState` hides the invite codes, entry links and credentials. A bot that logs
 * its replies read every pending chat's invite and the TURN credential in the clear.
 */
const INVITE = "ghostly-invite-pending-secret";
const CREDENTIAL = "turn-credential-secret";
const ENTRY = "ghostly-group-entry-secret";

function fake() {
  const links = [{ id: "chat-one", label: "Bob", inviteCode: INVITE, wakeToken: "wake-secret" }];
  const getState = () => ({
    links, groups: [{ id: "g1", entryLink: ENTRY }], transport: {}, identityProofs: [],
    settings: { iceServers: [{ urls: "turn:turn.example:3478", username: "u", credential: CREDENTIAL }] },
  }) as unknown as EngineState;
  const node = {
    getState,
    exportLinks: async () => ({ links: [{ id: "chat-one", seedB64: "seed-secret", encKeyB64: "key-secret", inviteCode: INVITE }] }),
    walletReceiveLightning: async () => ({ invoice: "lnbc1", quote: "quote-secret" }),
  };
  return { runtime: { server: { node }, paths: { name: "default" } }, hub: { emit: () => {}, onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;
}

describe("engine.call over the socket and secrets", () => {
  it("refuses a call that answers with secrets unless showSecret", async () => {
    const ctx = fake();
    await expect(callApi(ctx, "engine.call", { method: "exportLinks" })).rejects.toMatchObject({ code: "confirm", message: expect.stringContaining("showSecret: true over the socket") });
    expect(JSON.stringify(await callApi(ctx, "engine.call", { method: "exportLinks", showSecret: true }))).toContain("seed-secret");
  });

  it("getState hides invite codes, entry links and credentials unless showSecret", async () => {
    const ctx = fake();
    const hidden = JSON.stringify(await callApi(ctx, "engine.call", { method: "getState" }));
    for (const secret of [INVITE, CREDENTIAL, ENTRY, "wake-secret"]) expect(hidden).not.toContain(secret);
    expect(hidden).toContain("<hidden>");
    const shown = JSON.stringify(await callApi(ctx, "engine.call", { method: "getState", showSecret: true }));
    for (const secret of [INVITE, CREDENTIAL, ENTRY]) expect(shown).toContain(secret);
  });

  it("hides a Cashu quote's id unless showSecret", async () => {
    const ctx = fake();
    expect(await callApi(ctx, "engine.call", { method: "walletReceiveLightning", params: { amount: 10 } })).toMatchObject({ quote: "<hidden>" });
    expect(await callApi(ctx, "engine.call", { method: "walletReceiveLightning", params: { amount: 10 }, showSecret: true })).toMatchObject({ quote: "quote-secret" });
  });
});
