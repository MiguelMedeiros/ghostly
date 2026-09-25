import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity, identityStatement, newIdentityBinding, pubkyProofPath, PUBKY_PROOF_ROOT } from "@ghostly/core";
import type { ApprovalRequest, SignerContext, SignerSession } from "../src/proofs/contract";
import { createPubkyIdentityProvider, type PubkyEvidence } from "../src/proofs/providers/pubky";
import { passportUrl, PUBKY_CLIENT_ID, withPubkyApproval } from "../src/proofs/pubky";
// covers: proofs.pubky

/**
 * Asking for a Pubky approval (proofs/pubky.ts) with the SDK replaced: ONE grant request for one folder, shown as a
 * Passport button and a Ring QR code of the same URL; a session granted anything else is refused and signed out;
 * a cancel or a time-out ends it, and an approval landing afterwards is signed out; the request never reaches a log.
 */

/** Looks like a real one: the relay secret is in it. */
const AUTH_URL = "pubkyauth://signin?caps=%2Fpub%2Fghostly.app%2Fproofs%2F&relay=https%3A%2F%2Fhttprelay.pubky.app%2Finbox&secret=c2VjcmV0LXJlbGF5LWtleQ";

interface FakeSession {
  info: { publicKey: { z32(): string; free(): void }; capabilities: string[]; free(): void };
  storage: { putText: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
  signout: ReturnType<typeof vi.fn>;
  free: ReturnType<typeof vi.fn>;
}

const sdk = vi.hoisted(() => ({
  started: [] as { capabilities: string; kind: unknown; options: Record<string, unknown> }[],
  polls: [] as (() => Promise<unknown>)[],
  next: undefined as undefined | (() => Promise<unknown>),
  freed: 0,
  pending: 0,
}));

vi.mock("@synonymdev/pubky", () => ({
  AuthFlowKind: { signin: () => "signin" },
  GrantAuthFlow: {
    start(capabilities: string, kind: unknown, options: Record<string, unknown>) {
      sdk.started.push({ capabilities, kind, options });
      return {
        authorizationUrl: AUTH_URL,
        tryPollOnce: () => {
          sdk.pending++;
          const answer = (sdk.next ?? (async () => undefined))();
          return answer.finally(() => { sdk.pending--; });
        },
        free: () => { if (sdk.pending) throw new Error("freed while a call is in flight"); sdk.freed++; },
      };
    },
  },
}));

const me = createIdentity().pubKeyZ32;

function session(key = me, capabilities?: string[]): FakeSession {
  return {
    info: { publicKey: { z32: () => key, free: () => {} }, get capabilities() { return capabilities ?? [sdk.started.at(-1)!.capabilities]; }, free: () => {} },
    storage: { putText: vi.fn(async () => {}), delete: vi.fn(async () => {}) },
    signout: vi.fn(async () => {}),
    free: vi.fn(),
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function context(overrides: Partial<SignerContext> = {}) {
  const requests: (ApprovalRequest | null)[] = [];
  const controller = new AbortController();
  const ctx: SignerContext = {
    values: {}, signal: controller.signal, onAuthUrl: vi.fn(), onProgress: vi.fn(),
    onApproval: r => { requests.push(r); }, ...overrides,
  };
  return { ctx, requests, controller };
}

const statementFor = (subject: string) => identityStatement(newIdentityBinding({ provider: "pubky", subject, validitySeconds: 86_400 }).binding);

describe("Pubky approval", () => {
  const logs: unknown[][] = [];
  beforeEach(() => {
    Object.assign(sdk, { started: [], polls: [], next: undefined, freed: 0, pending: 0 });
    logs.length = 0;
    for (const level of ["log", "info", "warn", "error", "debug", "trace"] as const)
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logs.push(args); });
  });
  afterEach(() => {
    // Whatever happened, the request never reached a log.
    const logged = JSON.stringify(logs.map(args => args.map(String)));
    expect(logged).not.toContain("pubkyauth");
    expect(logged).not.toContain("c2VjcmV0");
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("asks for write access to one fresh proof folder, as ghostly.tools, and shows it both ways", async () => {
    const opened: string[] = [];
    const { ctx, requests } = context();
    const approved = session();
    sdk.next = async () => approved;
    const provider = createPubkyIdentityProvider({ approval: { openPassport: url => { opened.push(url); } } });
    const signer = provider.signers[0];
    if (signer.kind !== "in-app") throw new Error("in-app signer expected");
    let evidence: PubkyEvidence | undefined, made: ReturnType<typeof statementFor> | undefined;
    // The UI clicks the Passport button as soon as it shows.
    const onApproval = ctx.onApproval!;
    ctx.onApproval = r => { onApproval(r); r?.open?.run(); };
    await signer.run(ctx, async (s: SignerSession<PubkyEvidence>) => {
      const subject = await s.subject();
      expect(subject).toBe(me);
      made = statementFor(subject);
      evidence = await s.sign(made);
    });

    expect(sdk.started).toHaveLength(1);
    const { capabilities, options } = sdk.started[0];
    expect(capabilities).toMatch(new RegExp(`^${PUBKY_PROOF_ROOT.replaceAll(".", "\\.")}[a-f0-9]{64}/:w$`));
    expect(capabilities).not.toContain(",");
    expect(options).toMatchObject({ clientId: PUBKY_CLIENT_ID, xCallback: { xSource: "Ghostly" } });
    expect(evidence!.folder).toBe(capabilities.slice(PUBKY_PROOF_ROOT.length, -"/:w".length));

    // One screen: a Passport button and a Ring QR code, the same request; gone once approved.
    expect(requests[0]).toMatchObject({ qr: { value: AUTH_URL, label: "Or scan with Pubky Ring" }, open: { label: "Approve in your browser (Pubky Passport)" } });
    expect(requests[0]!.notes!.join(" ")).toMatch(/Google plus Passport/);
    expect(requests.at(-1)).toBeNull();
    // Passport's authorize page, the request in the fragment, encoded exactly once.
    expect(opened).toEqual([`https://passport.pubky.app/authorize#d=${encodeURIComponent(AUTH_URL)}`]);
    expect(opened[0]).toBe(passportUrl(AUTH_URL));
    expect(new URL(opened[0]).search).toBe("");
    expect(decodeURIComponent(new URL(opened[0]).hash.slice("#d=".length))).toBe(AUTH_URL);
    // The file went where the statement says, with exactly its bytes; then the session was ended and forgotten.
    expect(approved.storage.putText.mock.calls).toEqual([[pubkyProofPath(evidence!.folder, made!.id), made!.text]]);
    expect(approved.storage.delete).not.toHaveBeenCalled();
    expect(approved.signout).toHaveBeenCalledTimes(1);
    expect(approved.free).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(sdk.freed).toBe(1));
  });

  it("refuses a session granted any other permission, writes nothing and signs it out", async () => {
    for (const granted of [["/pub/ghostly.app/:w"], ["/:rw"], [], ["X", "Y"]]) {
      const approved = session(me, granted);
      sdk.next = async () => approved;
      await expect(withPubkyApproval({ capability: `/pub/ghostly.app/proofs/${"a".repeat(64)}/:w`, ...context().ctx, onApproval: () => {} }, async () => { throw new Error("work must not run"); }))
        .rejects.toThrow(/different permissions/);
      expect(approved.storage.putText).not.toHaveBeenCalled();
      expect(approved.signout).toHaveBeenCalled();
      expect(approved.free).toHaveBeenCalled();
    }
    // More than the one folder, even if it includes it.
    const extra = session(me, [`/pub/ghostly.app/proofs/${"a".repeat(64)}/:w`, "/pub/pubky.app/:rw"]);
    sdk.next = async () => extra;
    await expect(withPubkyApproval({ capability: `/pub/ghostly.app/proofs/${"a".repeat(64)}/:w`, ...context().ctx, onApproval: () => {} }, async () => "ran"))
      .rejects.toThrow(/different permissions/);
    expect(extra.signout).toHaveBeenCalled();
  });

  it("deletes what it wrote when the proof is not saved", async () => {
    const provider = createPubkyIdentityProvider();
    const approved = session();
    sdk.next = async () => approved;
    const { ctx } = context();
    const signer = provider.signers[0];
    if (signer.kind !== "in-app") throw new Error("in-app signer expected");
    await expect(signer.run(ctx, async s => { await s.sign(statementFor(await s.subject())); throw new Error("Your contact's check failed"); }))
      .rejects.toThrow(/check failed/);
    expect(approved.storage.delete).toHaveBeenCalledWith(approved.storage.putText.mock.calls[0][0]);
    expect(approved.signout).toHaveBeenCalled();
  });

  it("refuses to write a statement for another key than the one that approved", async () => {
    const provider = createPubkyIdentityProvider();
    const approved = session();
    sdk.next = async () => approved;
    const signer = provider.signers[0];
    if (signer.kind !== "in-app") throw new Error("in-app signer expected");
    await expect(signer.run(context().ctx, async s => { await s.sign(statementFor(createIdentity().pubKeyZ32)); })).rejects.toThrow(/another Pubky identity/);
    expect(approved.storage.putText).not.toHaveBeenCalled();
  });

  it("keeps polling until one of them approves, and a cancel ends it at once; a late approval is signed out", async () => {
    const poll = deferred<unknown>();
    sdk.next = () => poll.promise;
    const { ctx, requests, controller } = context();
    const work = vi.fn();
    const run = withPubkyApproval({ capability: `/pub/ghostly.app/proofs/${"b".repeat(64)}/:w`, signal: ctx.signal, onApproval: ctx.onApproval!, onProgress: ctx.onProgress }, work);
    await vi.waitFor(() => expect(sdk.pending).toBe(1));
    controller.abort(new Error("Cancelled"));
    await expect(run).rejects.toThrow(/Cancelled/);
    expect(work).not.toHaveBeenCalled();
    expect(requests.at(-1)).toBeNull();
    // The flow is not freed while its poll is in flight...
    expect(sdk.freed).toBe(0);
    // ...and the approval that lands late never becomes a usable session.
    const late = session();
    poll.resolve(late);
    await vi.waitFor(() => expect(late.signout).toHaveBeenCalled());
    expect(late.free).toHaveBeenCalled();
    await vi.waitFor(() => expect(sdk.freed).toBe(1));
  });

  it("gives up after its deadline", async () => {
    sdk.next = async () => undefined;
    const { ctx, requests } = context();
    await expect(withPubkyApproval({ capability: `/pub/ghostly.app/proofs/${"c".repeat(64)}/:w`, signal: ctx.signal, onApproval: ctx.onApproval!, onProgress: ctx.onProgress, timeoutMs: 1 }, vi.fn()))
      .rejects.toThrow(/in time/);
    expect(requests.at(-1)).toBeNull();
  });

  it("closes the Passport window once the request is approved (by either of them)", async () => {
    const window = { closed: false, close: vi.fn() };
    const poll = deferred<unknown>();
    sdk.next = () => poll.promise;
    const { ctx } = context({ onApproval: r => r?.open?.run() });
    const run = withPubkyApproval({ capability: `/pub/ghostly.app/proofs/${"d".repeat(64)}/:w`, signal: ctx.signal, onApproval: ctx.onApproval!, onProgress: ctx.onProgress,
      openPassport: () => window as unknown as Window }, async () => "done");
    await vi.waitFor(() => expect(sdk.pending).toBe(1));
    poll.resolve(session());
    await expect(run).resolves.toBe("done");
    expect(window.close).toHaveBeenCalled();
  });

  it("never shows the request in an error it passes on", async () => {
    sdk.next = async () => { throw new Error(`relay said no to ${AUTH_URL} (see ${passportUrl(AUTH_URL)})`); };
    const { ctx } = context();
    const error = await withPubkyApproval({ capability: `/pub/ghostly.app/proofs/${"e".repeat(64)}/:w`, signal: ctx.signal, onApproval: ctx.onApproval!, onProgress: ctx.onProgress }, vi.fn()).catch(e => e as Error);
    expect(error.message).toMatch(/The Pubky request failed/);
    expect(error.message).not.toContain("pubkyauth");
    expect(error.message).not.toContain("c2VjcmV0");
    console.error(error);
  });
});

describe("Pubky removal", () => {
  beforeEach(() => { Object.assign(sdk, { started: [], polls: [], next: undefined, freed: 0, pending: 0 }); });

  it("asks again for the proof's own folder and deletes exactly its file", async () => {
    const provider = createPubkyIdentityProvider();
    const statement = statementFor(me);
    const folder = "9".repeat(64);
    const approved = session();
    sdk.next = async () => approved;
    await provider.unpublish!.run({ id: statement.id, subject: me, evidence: { folder } }, context().ctx);
    expect(sdk.started[0].capabilities).toBe(`/pub/ghostly.app/proofs/${folder}/:w`);
    expect(approved.storage.delete).toHaveBeenCalledWith(pubkyProofPath(folder, statement.id));
    expect(approved.storage.putText).not.toHaveBeenCalled();
    expect(approved.signout).toHaveBeenCalled();
  });

  it("refuses an approval by another key", async () => {
    const provider = createPubkyIdentityProvider();
    const approved = session(createIdentity().pubKeyZ32);
    sdk.next = async () => approved;
    await expect(provider.unpublish!.run({ id: statementFor(me).id, subject: me, evidence: { folder: "9".repeat(64) } }, context().ctx)).rejects.toThrow(/another Pubky identity/);
    expect(approved.storage.delete).not.toHaveBeenCalled();
  });
});

describe("Pubky approval: a blocked popup", () => {
  beforeEach(() => { Object.assign(sdk, { started: [], polls: [], next: undefined, freed: 0, pending: 0 }); });

  it("says the browser blocked Passport and points to the QR code, and keeps waiting", async () => {
    const poll = deferred<unknown>();
    sdk.next = () => poll.promise;
    const onProgress = vi.fn();
    const run = withPubkyApproval({ capability: `/pub/ghostly.app/proofs/${"f".repeat(64)}/:w`, signal: new AbortController().signal,
      onApproval: r => r?.open?.run(), onProgress, openPassport: () => null }, async () => "done");
    await vi.waitFor(() => expect(onProgress).toHaveBeenCalledWith(expect.stringMatching(/blocked the Passport window.*Pubky Ring/)));
    poll.resolve(session());
    await expect(run).resolves.toBe("done");
  });
});
