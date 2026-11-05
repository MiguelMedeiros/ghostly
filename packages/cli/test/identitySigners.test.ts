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

  /**
   * `identity add` printed the app's steps as they are: "Then press Check" (a domain, a did:web), "paste it into Ghostly"
   * (a Bitcoin wallet), "Paste the whole signature it prints" (ssh-keygen). The CLI has neither the button nor the
   * field, and its answer never named `identity complete`, the step that finishes the proof here.
   */
  describe("identity add names the CLI's next step, not the app's", () => {
    type Added = { draft: string; instructions: { steps: { text: string; copy?: string }[]; paste?: string } };
    const APP_ONLY = /press Check|into Ghostly|\bpaste\b(?! the (statement|address))/i;
    function adding() {
      const { ctx, node } = fake();
      let n = 0;
      node.beginIdentityProof.mockImplementation(async ({ provider, subject }: { provider: string; subject: string }) => ({
        draftId: `d${++n}`, binding: { v: 1, provider, subject, key: "y".repeat(52), issuedAt: 1_800_000_000, expiresAt: 1_800_086_400, nonce: "A".repeat(22) },
      }));
      return (provider: string, subject: string, signer?: string) => callApi(ctx, "identity.add", { provider, subject, signer }) as Promise<Added>;
    }

    it("ssh-keygen: keep what it prints, then identity complete with this draft from a file or a pipe", async () => {
      const added = await adding()("ssh", `SHA256:${"A".repeat(43)}`);
      const texts = added.instructions.steps.map((s) => s.text);
      expect(texts.filter((t) => APP_ONLY.test(t))).toEqual([]);
      expect(texts).toContain("Keep the whole signature it prints, from -----BEGIN SSH SIGNATURE----- to -----END SSH SIGNATURE-----. Your private key never leaves your computer.");
      expect(added.instructions.steps.at(-1)).toEqual({
        text: `Then finish it with what you kept (SSH signature), from a file or piped to it (… | ghostly identity complete ${added.draft}). It answers the proof; show it to a contact with ghostly identity share <chat> <id>.`,
        copy: `ghostly identity complete ${added.draft} --evidence-file <file>`,
      });
    });

    it("gpg: the app's steps as they are, then identity complete with this draft", async () => {
      const added = await adding()("openpgp", "A".repeat(40), "gpg");
      expect(added.instructions.steps.slice(0, -1).map((s) => s.text)).toEqual([
        "Save the statement to a file (it is one line, with no newline at the end):",
        "Sign it and export your public key, then copy everything this prints:",
        "On a YubiKey or another OpenPGP card, gpg asks for the card's PIN, and for a touch if the card requires one. Without a shell, save the statement below in a text file and sign that file.",
      ]);
      expect(added.instructions.steps.at(-1)).toMatchObject({ text: expect.stringContaining(`(Signed statement and public key), from a file or piped to it (… | ghostly identity complete ${added.draft})`), copy: `ghostly identity complete ${added.draft} --evidence-file <file>` });
    });

    it("a published record (a domain's TXT, a GitHub account's key): no Check button, identity complete looks it up", async () => {
      const add = adding();
      const dns = await add("domain", "example.com", "dns");
      expect(dns.instructions.steps.map((s) => s.text)).toContain("Set the TTL to 300 seconds or less, so removing the record takes effect quickly. Then finish it with the last step: DNS changes can take a few minutes to appear.");
      expect(dns.instructions.steps.at(-1)).toEqual({
        text: "Once it is published, check it from here: the engine looks it up. It answers the proof; show it to a contact with ghostly identity share <chat> <id>.",
        copy: `ghostly identity complete ${dns.draft}`,
      });
      const github = await add("ssh-github", "octocat");
      expect(github.instructions.steps.filter((s) => APP_ONLY.test(s.text))).toEqual([]);
      expect(github.instructions.steps.at(-1)?.copy).toBe(`ghostly identity complete ${github.draft} --evidence-file <file>`);
    });

    it("no signer that runs here says press Check or paste into Ghostly", async () => {
      const add = adding();
      const SUBJECTS: Record<string, string[]> = {
        ssh: [`SHA256:${"A".repeat(43)}`], "ssh-github": ["octocat"], "ssh-gitlab": ["someone"], openpgp: ["A".repeat(40)], domain: ["example.com"],
        did: ["did:web:example.com", "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"],
        bitcoin: ["bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", "1BvBMSEYstWetqTFn5Au4m4GBg7xJaNVN2"],
      };
      const seen: string[] = [];
      for (const p of IDENTITY_PROVIDERS) for (const s of p.signers) {
        if (s.kind !== "external-tool" && s.kind !== "publish") continue;
        for (const subject of SUBJECTS[p.id] ?? []) {
          // did:key has no published form ("Publishing works for did:web only").
          const added = await add(p.id, subject, s.id).catch(() => undefined);
          if (!added) continue;
          seen.push(`${p.id}/${s.id}`);
          const wrong = added.instructions.steps.filter((step) => APP_ONLY.test(step.text)).map((step) => step.text);
          expect(wrong, `${p.id}/${s.id}`).toEqual([]);
          expect(added.instructions.steps.at(-1)?.copy, `${p.id}/${s.id}`).toMatch(new RegExp(`^ghostly identity complete ${added.draft}( --evidence-file <file>)?$`));
        }
      }
      expect(new Set(seen)).toEqual(new Set(["ssh/ssh-keygen", "ssh-github/ssh-keygen", "ssh-gitlab/ssh-keygen", "openpgp/gpg", "openpgp/gpg-keys-openpgp-org", "domain/dns", "domain/https",
        "did/sign", "did/file", "did/service", "bitcoin/sparrow", "bitcoin/bitcoin-core", "bitcoin/electrum", "bitcoin/coldcard", "bitcoin/trezor", "bitcoin/other"]));
    });
  });

  /**
   * The engine keeps a draft 30 minutes and four at once. `identity add` promised an hour (`expiresInSeconds: 3600`) and
   * kept every draft, so a draft the engine had dropped went on to it and failed as "This proof was started too long ago".
   */
  it("keeps a draft as long as the engine does, and says so", async () => {
    const { ctx, node } = fake();
    let n = 0;
    node.beginIdentityProof.mockImplementation(async ({ provider, subject }: { provider: string; subject: string }) => ({
      draftId: `keep${++n}`, binding: { v: 1, provider, subject, key: "y".repeat(52), issuedAt: 1_800_000_000, expiresAt: 1_800_086_400, nonce: "A".repeat(22) },
    }));
    node.completeIdentityProof.mockResolvedValue({ id: "p1", provider: "domain", subject: "example.com", verified: true, issuedAt: 1, expiresAt: 2, sharedWith: [] });
    const gone = { code: "not_found", message: "No such draft here: it is kept by the daemon that made it, for 30 minutes and while fewer than 4 newer ones wait" };
    const add = () => callApi(ctx, "identity.add", { provider: "domain", subject: "example.com", signer: "dns" }) as Promise<{ draft: string; expiresInSeconds: number }>;

    const added = [];
    for (let i = 0; i < 5; i++) added.push(await add());
    expect(added[0].expiresInSeconds).toBe(30 * 60);
    await expect(callApi(ctx, "identity.complete", { draft: added[0].draft })).rejects.toMatchObject(gone);
    await expect(callApi(ctx, "identity.complete", { draft: added[1].draft })).resolves.toMatchObject({ done: true });
    expect(node.completeIdentityProof).toHaveBeenCalledTimes(1);

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const old = await add();
      vi.setSystemTime(Date.now() + 31 * 60_000);
      await expect(callApi(ctx, "identity.complete", { draft: old.draft })).rejects.toMatchObject(gone);
      await expect(callApi(ctx, "identity.cancel", { draft: old.draft })).rejects.toMatchObject(gone);
    } finally { vi.useRealTimers(); }
    expect(node.completeIdentityProof).toHaveBeenCalledTimes(1);
  });
});
