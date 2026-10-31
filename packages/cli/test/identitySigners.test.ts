import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { EngineState } from "@ghostly/browser/shared/types";
import type { InAppSigner } from "@ghostly/browser/proofs/contract";
import { IDENTITY_PROVIDERS } from "@ghostly/browser/proofs/registry";
import { callApi, type ApiContext } from "../src/api";
import { EventHub, type GhostlyEvent } from "../src/events";
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
      code: "bad_request", message: "days must be a whole number from 1 to 365",
    });
    // A part of a day got past this to the engine's own check ("Choose between 1 and 365 days", engine).
    await expect(callApi(ctx, "identity.add", { provider: "ssh", subject: `SHA256:${"A".repeat(43)}`, signer: "ssh-keygen", days: 1.5 })).rejects.toMatchObject({
      code: "bad_request", message: "days must be a whole number from 1 to 365",
    });
    expect(node.beginIdentityProof).not.toHaveBeenCalled();
  });

  // It said "subject is required", the API's parameter, to `ghostly identity add domain` (the usage shows [subject]).
  it("asks for a missing subject in the provider's words, and where it goes", async () => {
    const { ctx, node } = fake();
    await expect(callApi(ctx, "identity.add", { provider: "domain" })).rejects.toMatchObject({
      code: "bad_request", message: "Domain takes a subject, its domain (example.com): ghostly identity add domain <subject>",
    });
    expect(node.beginIdentityProof).not.toHaveBeenCalled();
  });

  // The link or code a signer waits on holds the request's secret: it went into the event journal, kept on disk and
  // replayed to every `listen` that came later.
  it("reports a signer's approval link to the listeners live, never to the journal or a replay", async () => {
    const { ctx } = fake();
    const hub = new EventHub(join(mkdtempSync(join(tmpdir(), "ghostly-approval-")), "events.jsonl"), () => 1000, "approval");
    (ctx as unknown as { hub: EventHub }).hub = hub;
    const live: GhostlyEvent[] = [];
    hub.onEvent((e) => live.push(e));
    hub.emit("daemon.started", "daemon.started:1");
    const signer = IDENTITY_PROVIDERS.find((p) => p.id === "nostr")!.signers.find((s) => s.id === "nip46") as InAppSigner<unknown>;
    const run = vi.spyOn(signer, "run").mockImplementation(async (sctx) => {
      sctx.onAuthUrl("https://bunker.test/auth?secret=s3cret");
      sctx.onApproval?.({ qr: { value: "pubkyauth://signin?secret=s3cret", label: "Scan" }, notes: [] });
      throw new Error("stopped here");
    });
    try {
      await expect(callApi(ctx, "identity.add", { provider: "nostr", fields: { bunker: "bunker://x" } })).rejects.toThrow("stopped here");
    } finally { run.mockRestore(); }
    expect(live.filter((e) => e.type === "identity.approval").map((e) => e.url ?? e.qr)).toEqual(["https://bunker.test/auth?secret=s3cret", "pubkyauth://signin?secret=s3cret"]);
    expect(JSON.stringify(hub.replay(0))).not.toContain("s3cret");
    expect(hub.replay(0).map((e) => e.type)).toEqual(["daemon.started"]);
  });

  // Nobody approved a Pubky sign-in: it ended as `engine`, "The operation was aborted due to timeout", after 300 s,
  // naming neither the approval it waited for nor --timeout. A local double, not the public relay.
  it("an approval that does not come in time is a timeout naming it and --timeout", async () => {
    const { ctx, node } = fake();
    const signer = IDENTITY_PROVIDERS.find((p) => p.id === "pubky")!.signers.find((s) => s.kind === "in-app") as InAppSigner<unknown>;
    const run = vi.spyOn(signer, "run").mockImplementation((sctx) => new Promise((_, reject) => {
      sctx.signal!.addEventListener("abort", () => reject(sctx.signal!.reason));
    }));
    try {
      await expect(callApi(ctx, "identity.add", { provider: "pubky", timeout: 5 })).rejects.toMatchObject({
        code: "timeout", message: "Timed out after 5 s waiting for Pubky Ring or Pubky Passport to approve the Pubky proof: --timeout <seconds> waits longer",
      });
    } finally { run.mockRestore(); }
    expect(node.beginIdentityProof).not.toHaveBeenCalled();
  }, 15_000);

  // `identity complete <draft>` with nothing said "evidence is required", the API's word, naming neither way to give it.
  it("asks for a tool's missing output by where the CLI takes it, and a published record for none", async () => {
    const { ctx, node } = fake();
    let n = 0;
    node.beginIdentityProof.mockImplementation(async ({ provider, subject }: { provider: string; subject: string }) => ({
      draftId: `d${++n}`, binding: { v: 1, provider, subject, key: "y".repeat(52), issuedAt: 1_800_000_000, expiresAt: 1_800_086_400, nonce: "A".repeat(22) },
    }));
    node.completeIdentityProof.mockResolvedValue({ id: "p1", provider: "domain", subject: "example.com", verified: true, issuedAt: 1, expiresAt: 2, sharedWith: [] });
    const ssh = await callApi(ctx, "identity.add", { provider: "ssh", subject: `SHA256:${"A".repeat(43)}`, signer: "ssh-keygen" }) as { draft: string };
    for (const evidence of [undefined, "", " \n"]) {
      await expect(callApi(ctx, "identity.complete", { draft: ssh.draft, evidence })).rejects.toMatchObject({
        code: "usage", details: { needs: "evidence" },
        message: `Missing what ssh-keygen printed: give it from a file (--evidence-file f) or on stdin (… | ghostly identity complete ${ssh.draft})`,
      });
    }
    expect(node.completeIdentityProof).not.toHaveBeenCalled();
    const domain = await callApi(ctx, "identity.add", { provider: "domain", subject: "example.com", signer: "dns" }) as { draft: string };
    await expect(callApi(ctx, "identity.complete", { draft: domain.draft })).resolves.toMatchObject({ done: true });
    expect(node.completeIdentityProof).toHaveBeenCalledWith({ draftId: domain.draft, evidence: { method: "dns" } });
  });
});
