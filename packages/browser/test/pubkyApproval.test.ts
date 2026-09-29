import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity, identityStatement, newIdentityBinding, pubkyProofPath, PUBKY_PROOF_ROOT } from "@ghostly/core";
import type { ApprovalRequest, SignerContext, SignerSession } from "../src/proofs/contract";
import { createPubkyIdentityProvider, type PubkyEvidence } from "../src/proofs/providers/pubky";
import { passportUrl, PUBKY_CLIENT_ID, withPubkyApproval } from "../src/proofs/pubky";
// covers: proofs.pubky

/**
 * Asking for a Pubky approval (proofs/pubky.ts) with the SDK replaced: one request for one folder in two forms, a grant
 * request behind the Passport button and a cookie request in Ring's QR code, and the first approval wins; a session
 * granted anything else is refused and signed out; a cancel, a time-out or a failure ends both, frees both once no
 * poll is in flight, and an approval landing afterwards is signed out; the requests never reach a log.
 */

/** Look like real ones: the relay secrets are in them. */
const GRANT_URL = "pubkyauth://signin_grant?caps=%2Fpub%2Fghostly.app%2Fproofs%2F&relay=https%3A%2F%2Fhttprelay.pubky.app%2Finbox&secret=Z3JhbnQtcmVsYXkta2V5&cid=ghostly.tools&cpk=cG9wLWtleQ&x-source=Ghostly";
const COOKIE_URL = "pubkyauth://signin?caps=%2Fpub%2Fghostly.app%2Fproofs%2F&relay=https%3A%2F%2Fhttprelay.pubky.app%2Finbox&secret=Y29va2llLXJlbGF5LWtleQ&x-source=Ghostly";
const SECRETS = ["Z3JhbnQtcmVsYXkta2V5", "Y29va2llLXJlbGF5LWtleQ"];

interface FakeSession {
  info: { publicKey: { z32(): string; free(): void }; capabilities: string[]; free(): void };
  storage: { putText: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
  signout: ReturnType<typeof vi.fn>;
  free: ReturnType<typeof vi.fn>;
}

const sdk = vi.hoisted(() => ({
  started: [] as { form: "grant" | "cookie"; capabilities: string; kind: unknown; relay: unknown; xCallback: unknown; clientId?: unknown }[],
  /** What each form's next poll answers (undefined: nothing approved yet). */
  answer: {} as Partial<Record<"grant" | "cookie", () => Promise<unknown>>>,
  polls: { grant: 0, cookie: 0 },
  pending: { grant: 0, cookie: 0 },
  freed: [] as ("grant" | "cookie")[],
  pollsAfterFree: 0,
  failCookieStart: false,
}));

vi.mock("@synonymdev/pubky", () => {
  const flow = (form: "grant" | "cookie", authorizationUrl: string) => {
    let freed = false;
    return {
      authorizationUrl,
      tryPollOnce: () => {
        if (freed) sdk.pollsAfterFree++;
        sdk.polls[form]++;
        sdk.pending[form]++;
        return (sdk.answer[form] ?? (async () => undefined))().finally(() => { sdk.pending[form]--; });
      },
      free: () => {
        if (sdk.pending[form]) throw new Error("freed while a call is in flight");
        freed = true;
        sdk.freed.push(form);
      },
    };
  };
  return {
    // A fresh value each time: the real one is moved into the flow it starts, so it cannot start two.
    AuthFlowKind: { signin: () => ({ intent: "signin" }) },
    GrantAuthFlow: {
      start(capabilities: string, kind: unknown, options: { clientId: unknown; relay: unknown; xCallback: unknown }) {
        sdk.started.push({ form: "grant", capabilities, kind, relay: options.relay, xCallback: options.xCallback, clientId: options.clientId });
        return flow("grant", "pubkyauth://signin_grant?caps=%2Fpub%2Fghostly.app%2Fproofs%2F&relay=https%3A%2F%2Fhttprelay.pubky.app%2Finbox&secret=Z3JhbnQtcmVsYXkta2V5&cid=ghostly.tools&cpk=cG9wLWtleQ&x-source=Ghostly");
      },
    },
    AuthFlow: {
      start(capabilities: string, kind: unknown, relay: unknown, xCallback: unknown) {
        if (sdk.failCookieStart) throw new Error("Invalid capability in pubkyauth://signin?secret=Y29va2llLXJlbGF5LWtleQ");
        sdk.started.push({ form: "cookie", capabilities, kind, relay, xCallback });
        return flow("cookie", "pubkyauth://signin?caps=%2Fpub%2Fghostly.app%2Fproofs%2F&relay=https%3A%2F%2Fhttprelay.pubky.app%2Finbox&secret=Y29va2llLXJlbGF5LWtleQ&x-source=Ghostly");
      },
    },
  };
});

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

const bothFreed = () => expect([...sdk.freed].sort()).toEqual(["cookie", "grant"]);
const reset = () => Object.assign(sdk, { started: [], answer: {}, polls: { grant: 0, cookie: 0 }, pending: { grant: 0, cookie: 0 }, freed: [], pollsAfterFree: 0, failCookieStart: false });

const statementFor = (subject: string) => identityStatement(newIdentityBinding({ provider: "pubky", subject, validitySeconds: 86_400 }).binding);

describe("Pubky approval", () => {
  const logs: unknown[][] = [];
  beforeEach(() => {
    reset();
    logs.length = 0;
    for (const level of ["log", "info", "warn", "error", "debug", "trace"] as const)
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logs.push(args); });
  });
  afterEach(() => {
    // Whatever happened, the request never reached a log.
    const logged = JSON.stringify(logs.map(args => args.map(String)));
    expect(logged).not.toContain("pubkyauth");
    for (const secret of SECRETS) expect(logged).not.toContain(secret);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("asks for write access to one fresh proof folder, as ghostly.tools, and shows it both ways", async () => {
    const opened: string[] = [];
    const { ctx, requests } = context();
    const approved = session();
    sdk.answer.grant = async () => approved;
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

    // The same request in two forms: a grant for Passport, a cookie request for Ring, same capability and relay.
    expect(sdk.started.map(started => started.form)).toEqual(["grant", "cookie"]);
    const [grant, cookie] = sdk.started;
    const { capabilities } = grant;
    expect(capabilities).toMatch(new RegExp(`^${PUBKY_PROOF_ROOT.replaceAll(".", "\\.")}[a-f0-9]{64}/:w$`));
    expect(capabilities).not.toContain(",");
    expect(grant).toMatchObject({ clientId: PUBKY_CLIENT_ID, relay: null, xCallback: { xSource: "Ghostly" } });
    expect(cookie).toMatchObject({ capabilities, relay: null, xCallback: { xSource: "Ghostly" } });
    // A sign-in each, each its own: the SDK moves the kind into the flow it starts.
    expect(grant.kind).toEqual({ intent: "signin" });
    expect(cookie.kind).toEqual({ intent: "signin" });
    expect(cookie.kind).not.toBe(grant.kind);
    expect(evidence!.folder).toBe(capabilities.slice(PUBKY_PROOF_ROOT.length, -"/:w".length));

    // One screen: a Passport button and a Ring QR code (the cookie request); gone once approved.
    expect(requests[0]).toMatchObject({ qr: { value: COOKIE_URL, label: "Or scan with Pubky Ring" }, open: { label: "Approve in your browser (Pubky Passport)" } });
    expect(requests[0]!.notes!.join(" ")).toMatch(/Google plus Passport/);
    expect(requests.at(-1)).toBeNull();
    // Passport's authorize page, the grant request in the fragment, encoded exactly once.
    expect(opened).toEqual([`https://passport.pubky.app/authorize#d=${encodeURIComponent(GRANT_URL)}`]);
    expect(opened[0]).toBe(passportUrl(GRANT_URL));
    expect(new URL(opened[0]).search).toBe("");
    expect(decodeURIComponent(new URL(opened[0]).hash.slice("#d=".length))).toBe(GRANT_URL);
    // The file went where the statement says, with exactly its bytes; then the session was ended and forgotten.
    expect(approved.storage.putText.mock.calls).toEqual([[pubkyProofPath(evidence!.folder, made!.id), made!.text]]);
    expect(approved.storage.delete).not.toHaveBeenCalled();
    expect(approved.signout).toHaveBeenCalledTimes(1);
    expect(approved.free).toHaveBeenCalledTimes(1);
    await vi.waitFor(bothFreed);
    expect(sdk.pollsAfterFree).toBe(0);
  });

  it("refuses a session granted any other permission, from either side, writes nothing and signs it out", async () => {
    for (const [form, granted] of [["grant", ["/pub/ghostly.app/:w"]], ["cookie", ["/:rw"]], ["grant", []], ["cookie", ["X", "Y"]]] as const) {
      reset();
      const approved = session(me, [...granted]);
      sdk.answer[form] = async () => approved;
      await expect(withPubkyApproval({ capability: `/pub/ghostly.app/proofs/${"a".repeat(64)}/:w`, ...context().ctx, onApproval: () => {} }, async () => { throw new Error("work must not run"); }))
        .rejects.toThrow(/different permissions/);
      expect(approved.storage.putText).not.toHaveBeenCalled();
      expect(approved.signout).toHaveBeenCalled();
      expect(approved.free).toHaveBeenCalled();
    }
    // More than the one folder, even if it includes it.
    const extra = session(me, [`/pub/ghostly.app/proofs/${"a".repeat(64)}/:w`, "/pub/pubky.app/:rw"]);
    sdk.answer.grant = async () => extra;
    await expect(withPubkyApproval({ capability: `/pub/ghostly.app/proofs/${"a".repeat(64)}/:w`, ...context().ctx, onApproval: () => {} }, async () => "ran"))
      .rejects.toThrow(/different permissions/);
    expect(extra.signout).toHaveBeenCalled();
  });

  it("deletes what it wrote when the proof is not saved", async () => {
    const provider = createPubkyIdentityProvider();
    const approved = session();
    sdk.answer.grant = async () => approved;
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
    sdk.answer.grant = async () => approved;
    const signer = provider.signers[0];
    if (signer.kind !== "in-app") throw new Error("in-app signer expected");
    await expect(signer.run(context().ctx, async s => { await s.sign(statementFor(createIdentity().pubKeyZ32)); })).rejects.toThrow(/another Pubky identity/);
    expect(approved.storage.putText).not.toHaveBeenCalled();
  });

  it("keeps polling both until one of them approves, and a cancel ends it at once; late approvals are signed out", async () => {
    const grantPoll = deferred<unknown>(), cookiePoll = deferred<unknown>();
    sdk.answer = { grant: () => grantPoll.promise, cookie: () => cookiePoll.promise };
    const { ctx, requests, controller } = context();
    const work = vi.fn();
    const run = withPubkyApproval({ capability: `/pub/ghostly.app/proofs/${"b".repeat(64)}/:w`, signal: ctx.signal, onApproval: ctx.onApproval!, onProgress: ctx.onProgress }, work);
    await vi.waitFor(() => expect(sdk.pending).toEqual({ grant: 1, cookie: 1 }));
    controller.abort(new Error("Cancelled"));
    await expect(run).rejects.toThrow(/Cancelled/);
    expect(work).not.toHaveBeenCalled();
    expect(requests.at(-1)).toBeNull();
    // Neither flow is freed while its poll is in flight...
    expect(sdk.freed).toEqual([]);
    // ...and the approvals that land late never become usable sessions.
    const late = [session(), session()];
    grantPoll.resolve(late[0]);
    cookiePoll.resolve(late[1]);
    for (const s of late) {
      await vi.waitFor(() => expect(s.signout).toHaveBeenCalled());
      expect(s.free).toHaveBeenCalled();
      expect(s.storage.putText).not.toHaveBeenCalled();
    }
    await vi.waitFor(bothFreed);
    expect(sdk.polls).toEqual({ grant: 1, cookie: 1 });
    expect(sdk.pollsAfterFree).toBe(0);
  });

  it("takes the first approval from either side; the other request is freed at once and polled no more", async () => {
    for (const [winner, loser] of [["grant", "cookie"], ["cookie", "grant"]] as const) {
      reset();
      const approved = session();
      let asked = 0;
      // The winner is approved on its third poll; the loser never is.
      sdk.answer[winner] = async () => (++asked === 3 ? approved : undefined);
      const run = withPubkyApproval({ capability: `/pub/ghostly.app/proofs/${"a".repeat(64)}/:w`, ...context().ctx, onApproval: () => {} }, async s => {
        await s.put(`/pub/ghostly.app/proofs/${"a".repeat(64)}/x.txt`, "hello");
        return s.key;
      });
      await expect(run).resolves.toBe(me);
      expect(approved.storage.putText).toHaveBeenCalledTimes(1);
      expect(approved.signout).toHaveBeenCalledTimes(1);
      // The loser's wait between polls is cut short: freed well before the next poll would be due (1 s).
      await vi.waitFor(bothFreed, { timeout: 300, interval: 10 });
      const polls = { ...sdk.polls };
      expect(polls[winner]).toBe(3);
      expect(polls[loser]).toBeGreaterThanOrEqual(1);
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(sdk.polls).toEqual(polls);
      expect(sdk.pollsAfterFree).toBe(0);
    }
  });

  it("ends both when either request fails, and frees both", async () => {
    const grantPoll = deferred<unknown>();
    sdk.answer = { grant: () => grantPoll.promise, cookie: async () => { throw new Error("The homeserver refused the token"); } };
    const { ctx, requests } = context();
    await expect(withPubkyApproval({ capability: `/pub/ghostly.app/proofs/${"9".repeat(64)}/:w`, signal: ctx.signal, onApproval: ctx.onApproval!, onProgress: ctx.onProgress }, vi.fn()))
      .rejects.toThrow(/The Pubky request failed: The homeserver refused the token/);
    expect(requests.at(-1)).toBeNull();
    // The grant request's poll is still out: it is freed when that settles, and what it brings is signed out.
    expect(sdk.freed).toEqual(["cookie"]);
    const late = session();
    grantPoll.resolve(late);
    await vi.waitFor(() => expect(late.signout).toHaveBeenCalled());
    await vi.waitFor(bothFreed);
  });

  it("frees the grant request when the cookie request cannot start", async () => {
    sdk.failCookieStart = true;
    const { ctx, requests } = context();
    const error = await withPubkyApproval({ capability: `/pub/ghostly.app/proofs/${"8".repeat(64)}/:w`, signal: ctx.signal, onApproval: ctx.onApproval!, onProgress: ctx.onProgress }, vi.fn()).catch(e => e as Error);
    expect(error.message).toMatch(/^Could not start a Pubky request: Invalid capability in \(request\)$/);
    expect(sdk.freed).toEqual(["grant"]);
    expect(requests).toEqual([]);
  });

  it("gives up after its deadline, even with a poll in flight, and polls no more", async () => {
    const stuck = deferred<unknown>();
    // The grant request's poll never answers in time; the cookie request answers "not yet" each time.
    sdk.answer = { grant: () => stuck.promise, cookie: async () => undefined };
    const { ctx, requests } = context();
    await expect(withPubkyApproval({ capability: `/pub/ghostly.app/proofs/${"c".repeat(64)}/:w`, signal: ctx.signal, onApproval: ctx.onApproval!, onProgress: ctx.onProgress, timeoutMs: 30 }, vi.fn()))
      .rejects.toThrow(/in time/);
    expect(requests.at(-1)).toBeNull();
    await vi.waitFor(() => expect(sdk.freed).toEqual(["cookie"]), { timeout: 300, interval: 10 });
    stuck.resolve(undefined);
    await vi.waitFor(bothFreed);
    expect(sdk.polls.grant).toBe(1);
    expect(sdk.pollsAfterFree).toBe(0);
  });

  it("says a blocked cookie is why a Ring session could not write, and signs it out", async () => {
    const statusError = (statusCode: number) => Object.assign(new Error(`Request failed with status ${statusCode}`), { name: "RequestError", data: { statusCode } });
    for (const [form, statusCode, message] of [
      ["cookie", 401, /^Pubky Ring approved, but this browser blocked the sign-in cookie of your homeserver/],
      ["cookie", 403, /blocked the sign-in cookie/],
      ["cookie", 500, /^Could not write to your homeserver: Request failed with status 500$/],
      ["grant", 401, /^Could not write to your homeserver: Request failed with status 401$/],
    ] as const) {
      reset();
      const approved = session();
      approved.storage.putText.mockRejectedValue(statusError(statusCode));
      sdk.answer[form] = async () => approved;
      await expect(withPubkyApproval({ capability: `/pub/ghostly.app/proofs/${"7".repeat(64)}/:w`, ...context().ctx, onApproval: () => {} },
        s => s.put(`/pub/ghostly.app/proofs/${"7".repeat(64)}/x.txt`, "x")), `${form} ${statusCode}`).rejects.toThrow(message);
      expect(approved.signout).toHaveBeenCalled();
      expect(approved.free).toHaveBeenCalled();
    }
  });

  it("closes the Passport window once the request is approved (by either of them: here Ring)", async () => {
    const window = { closed: false, close: vi.fn() };
    const poll = deferred<unknown>();
    sdk.answer.cookie = () => poll.promise;
    const { ctx } = context({ onApproval: r => r?.open?.run() });
    const run = withPubkyApproval({ capability: `/pub/ghostly.app/proofs/${"d".repeat(64)}/:w`, signal: ctx.signal, onApproval: ctx.onApproval!, onProgress: ctx.onProgress,
      openPassport: () => window as unknown as Window }, async () => "done");
    await vi.waitFor(() => expect(sdk.pending.cookie).toBe(1));
    poll.resolve(session());
    await expect(run).resolves.toBe("done");
    expect(window.close).toHaveBeenCalled();
  });

  it("never shows the request in an error it passes on", async () => {
    sdk.answer.grant = async () => { throw new Error(`relay said no to ${GRANT_URL} and ${COOKIE_URL} (see ${passportUrl(GRANT_URL)})`); };
    const { ctx } = context();
    const error = await withPubkyApproval({ capability: `/pub/ghostly.app/proofs/${"e".repeat(64)}/:w`, signal: ctx.signal, onApproval: ctx.onApproval!, onProgress: ctx.onProgress }, vi.fn()).catch(e => e as Error);
    expect(error.message).toMatch(/The Pubky request failed/);
    expect(error.message).not.toContain("pubkyauth");
    for (const secret of SECRETS) expect(error.message).not.toContain(secret);
    console.error(error);
  });
});

describe("Pubky removal", () => {
  beforeEach(reset);

  it("asks again for the proof's own folder and deletes exactly its file", async () => {
    const provider = createPubkyIdentityProvider();
    const statement = statementFor(me);
    const folder = "9".repeat(64);
    const approved = session();
    sdk.answer.grant = async () => approved;
    await provider.unpublish!.run({ id: statement.id, subject: me, key: statement.binding.key, evidence: { folder } }, context().ctx);
    expect(sdk.started[0].capabilities).toBe(`/pub/ghostly.app/proofs/${folder}/:w`);
    expect(approved.storage.delete).toHaveBeenCalledWith(pubkyProofPath(folder, statement.id));
    expect(approved.storage.putText).not.toHaveBeenCalled();
    expect(approved.signout).toHaveBeenCalled();
  });

  it("refuses an approval by another key", async () => {
    const provider = createPubkyIdentityProvider();
    const approved = session(createIdentity().pubKeyZ32);
    sdk.answer.grant = async () => approved;
    await expect(provider.unpublish!.run({ id: statementFor(me).id, subject: me, key: "k".repeat(52), evidence: { folder: "9".repeat(64) } }, context().ctx)).rejects.toThrow(/another Pubky identity/);
    expect(approved.storage.delete).not.toHaveBeenCalled();
  });

  it("refuses stored evidence that is not exactly a folder, before asking anything", async () => {
    const provider = createPubkyIdentityProvider();
    for (const evidence of [undefined, {}, { folder: "../../x" }, { folder: "9".repeat(64), host: "evil.example.com" }])
      await expect(provider.unpublish!.run({ id: statementFor(me).id, subject: me, key: "k".repeat(52), evidence }, context().ctx), JSON.stringify(evidence)).rejects.toThrow(/not Pubky proof evidence/);
    expect(sdk.started).toEqual([]);
  });
});

describe("Pubky approval: a blocked popup", () => {
  beforeEach(reset);

  it("says the browser blocked Passport and points to the QR code, and keeps waiting", async () => {
    const poll = deferred<unknown>();
    sdk.answer.grant = () => poll.promise;
    const onProgress = vi.fn();
    const run = withPubkyApproval({ capability: `/pub/ghostly.app/proofs/${"f".repeat(64)}/:w`, signal: new AbortController().signal,
      onApproval: r => r?.open?.run(), onProgress, openPassport: () => null }, async () => "done");
    await vi.waitFor(() => expect(onProgress).toHaveBeenCalledWith(expect.stringMatching(/blocked the Passport window.*Pubky Ring/)));
    poll.resolve(session());
    await expect(run).resolves.toBe("done");
  });
});
