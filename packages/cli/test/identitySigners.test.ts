import { describe, expect, it, vi } from "vitest";
import type { EngineState } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
// covers: headless.identities

/**
 * Only the signers that run in this process count as headless. A NIP-07 extension and an AT Protocol sign-in window
 * live in the app's page: `identity providers` listed them as headless, and `identity add nostr` picked NIP-07 by
 * default, so a bunker given with `--field` was never used and the command failed with "No NIP-07 signer in this window".
 */
function fake() {
  const node = {
    getState: () => ({ links: [], groups: [], settings: {}, transport: {}, identityProofs: [] }) as unknown as EngineState,
    beginIdentityProof: vi.fn(), completeIdentityProof: vi.fn(), cancelIdentityProof: vi.fn(),
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { emit: () => {}, onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;
  return { ctx, node };
}

type Providers = { providers: { id: string; signers: { id: string; headless: boolean }[] }[] };
const headless = (list: Providers, provider: string) => Object.fromEntries(list.providers.find((p) => p.id === provider)!.signers.map((s) => [s.id, s.headless]));

describe("identity signers on Node", () => {
  it("lists a signer that needs the app's page as not headless", async () => {
    const list = await callApi(fake().ctx, "identity.providers", {}) as Providers;
    expect(headless(list, "nostr")).toEqual({ nip07: false, nip46: true });
    expect(headless(list, "domain")).toEqual({ dns: true, https: true, "nip05-nip07": false, "nip05-nip46": true });
    expect(Object.values(headless(list, "atproto"))).toEqual([false, false]);
    expect(Object.values(headless(list, "oidc"))).toEqual([false, false, false]);
    expect(headless(list, "ssh")).toEqual({ "ssh-keygen": true });
  });

  it("a Nostr proof takes the remote signer by default, and asks for its link", async () => {
    const { ctx, node } = fake();
    await expect(callApi(ctx, "identity.add", { provider: "nostr" })).rejects.toMatchObject({ code: "bad_request", message: "Remote signer (NIP-46) needs bunker (Signer connection link)" });
    expect(node.beginIdentityProof).not.toHaveBeenCalled();
  });

  it("a signer named that needs the app's page is refused, naming the one that runs here", async () => {
    const { ctx } = fake();
    await expect(callApi(ctx, "identity.add", { provider: "nostr", signer: "nip07" })).rejects.toMatchObject({
      code: "unavailable", message: "Browser extension (NIP-07) needs a browser window: make this proof in the app (here: --signer nip46)",
    });
    await expect(callApi(ctx, "identity.add", { provider: "atproto", fields: { handle: "alice.test" } })).rejects.toMatchObject({
      code: "unavailable", message: "Bluesky / AT Protocol proofs need a browser window: make them in the app",
    });
  });

  it("refuses a subject the provider cannot read, or more days than it allows, before the engine is asked", async () => {
    const { ctx, node } = fake();
    await expect(callApi(ctx, "identity.add", { provider: "ssh", subject: "not-a-key", signer: "ssh-keygen" })).rejects.toMatchObject({
      code: "bad_request", message: "Paste your public key (the one line in ~/.ssh/id_ed25519.pub) or its SHA256: fingerprint",
    });
    await expect(callApi(ctx, "identity.add", { provider: "ssh", subject: `SHA256:${"A".repeat(43)}`, signer: "ssh-keygen", days: 400 })).rejects.toMatchObject({
      code: "bad_request", message: "days must be a number from 1 to 365",
    });
    expect(node.beginIdentityProof).not.toHaveBeenCalled();
  });
});
