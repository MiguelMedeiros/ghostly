import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ATPROTO_DECLARED_SCOPE, ATPROTO_FULL_SCOPE, ATPROTO_PROOF_COLLECTION, ATPROTO_PROOF_SCOPE, identityStatement, newIdentityBinding, normalizeAtprotoHandle } from "@ghostly/core";
import type { InAppSigner, SignerContext } from "../src/proofs/contract";
import {
  ATPROTO_CLIENT_METADATA, ATPROTO_REDIRECTS, AtprotoScopeError, callbackParams, clientMetadataFor, lookupAtprotoAccount, publishAtprotoProof,
  scopeFor, unpublishAtprotoProof, type AtprotoFlowOptions, type AtprotoHost, type AtprotoWindow,
} from "../src/proofs/atproto/oauth";
import { createAtprotoIdentityProvider, type AtprotoEvidence } from "../src/proofs/providers/atproto";
import { testAtprotoNetwork } from "./helpers/atprotoNetwork";
// covers: proofs.atproto, proofs.atproto.oauth

/** What Ghostly hands the client: read loosely, the way the library would. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Options = Record<string, any>;
/** The official client, replaced at its boundary: what Ghostly asks of it, and what it hands back. */
const lib = vi.hoisted(() => ({
  instances: [] as { options: Options; authorized?: { input: string; opts: Record<string, unknown> }; resolved?: unknown; params?: URLSearchParams }[],
  authorizeError: undefined as unknown,
  callbackError: undefined as unknown,
  session: undefined as unknown,
}));
vi.mock("@atproto/oauth-client", () => ({
  OAuthClient: class {
    options: Options;
    authorized?: { input: string; opts: Record<string, unknown> };
    resolved?: unknown;
    params?: URLSearchParams;
    constructor(options: Options) { this.options = options; lib.instances.push(this); }
    async authorize(input: string, opts: Record<string, unknown>) {
      this.authorized = { input, opts };
      this.resolved = await this.options.identityResolver.resolve(input);
      if (lib.authorizeError) throw lib.authorizeError;
      await this.options.stateStore.set("S".repeat(22), { iss: "https://pds.example.com" });
      return new URL("https://pds.example.com/oauth/authorize?client_id=x&request_uri=urn%3Areq");
    }
    async callback(params: URLSearchParams) {
      this.params = params;
      if (lib.callbackError) throw lib.callbackError;
      return { session: lib.session, state: null };
    }
  },
}));
vi.mock("@atproto/jwk-webcrypto", () => ({ WebcryptoKey: { generate: vi.fn() } }));

type Call = { path: string; body: Record<string, unknown> };
function fakeSession(did: string, status = 200) {
  const calls: Call[] = [];
  const session = {
    did, calls, signedOut: 0,
    async fetchHandler(path: string, init?: RequestInit) { calls.push({ path, body: JSON.parse(String(init?.body)) }); return new Response(JSON.stringify(status === 200 ? {} : { error: "Nope", message: "no" }), { status }); },
    async signOut() { session.signedOut++; },
  };
  return session;
}

function fakeWindow(redirectUri = ATPROTO_REDIRECTS.web, answer: (state: string) => string = state => `${redirectUri}#state=${state}&iss=https%3A%2F%2Fpds.example.com&code=c0de`) {
  const log: string[] = [];
  const w: AtprotoWindow = {
    redirectUri,
    async authorize(url, state) { log.push(`authorize ${url} ${state}`); return answer(state); },
    close() { log.push("close"); },
  };
  return { w, log };
}

const net = testAtprotoNetwork();
const alice = net.account("alice");
const statement = identityStatement(newIdentityBinding({ provider: "atproto", subject: alice.did, validitySeconds: 90 * 86_400 }).binding);

async function flow(overrides: Partial<AtprotoFlowOptions> = {}): Promise<AtprotoFlowOptions & { log: string[] }> {
  const account = await lookupAtprotoAccount(alice.handle, { fetch: net.fetch, normalize: normalizeAtprotoHandle });
  const { w, log } = fakeWindow();
  return { platform: "web", window: w, account, access: "proof-records", signal: new AbortController().signal, resolve: { fetch: net.fetch }, onProgress: () => {}, log, ...overrides };
}

beforeEach(() => { lib.instances.length = 0; lib.authorizeError = undefined; lib.callbackError = undefined; lib.session = fakeSession(alice.did); });

describe("the client Ghostly presents", () => {
  it("is the published metadata document, byte for byte in meaning", () => {
    const published = JSON.parse(readFileSync(new URL("../../../website/public/oauth/client-metadata.json", import.meta.url), "utf8"));
    expect(published).toEqual(ATPROTO_CLIENT_METADATA);
    expect(ATPROTO_CLIENT_METADATA.client_id).toBe("https://ghostly.tools/oauth/client-metadata.json");
    expect(ATPROTO_CLIENT_METADATA.grant_types).toEqual(["authorization_code"]);
  });

  it("asks only for Ghostly's own records, and declares every scope it may ask for", () => {
    expect(scopeFor("proof-records")).toBe(`atproto repo:${ATPROTO_PROOF_COLLECTION}?action=create&action=delete`);
    expect(scopeFor("full")).toBe(ATPROTO_FULL_SCOPE);
    const declared = ATPROTO_DECLARED_SCOPE.split(" ");
    for (const scope of [ATPROTO_PROOF_SCOPE, ATPROTO_FULL_SCOPE]) for (const token of scope.split(" ")) expect(declared).toContain(token);
    expect(ATPROTO_PROOF_SCOPE).not.toMatch(/transition|app\.bsky|chat|blob|rpc/);
  });

  it("picks the development client on a loopback web app, and lets a loopback port vary", () => {
    const local = clientMetadataFor("web", "http://127.0.0.1:51010/oidc-callback.html");
    expect(local.client_id).toBe(`http://localhost?redirect_uri=${encodeURIComponent("http://127.0.0.1/oidc-callback.html")}&scope=${new URLSearchParams({ s: ATPROTO_DECLARED_SCOPE }).toString().slice(2)}`);
    expect(local.redirect_uris).toContain("http://127.0.0.1:51010/oidc-callback.html");
    const desktop = clientMetadataFor("desktop", "http://127.0.0.1:43123/oidc-callback");
    expect(desktop.client_id).toBe(ATPROTO_CLIENT_METADATA.client_id);
    expect(desktop.redirect_uris).toContain("http://127.0.0.1:43123/oidc-callback");
    expect(clientMetadataFor("web", ATPROTO_REDIRECTS.web).client_id).toBe(ATPROTO_CLIENT_METADATA.client_id);
    expect(clientMetadataFor("extension", ATPROTO_REDIRECTS.extension).client_id).toBe(ATPROTO_CLIENT_METADATA.client_id);
  });

  it("refuses a return address that is not registered (an unpacked extension, another site)", () => {
    expect(() => clientMetadataFor("extension", "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/atproto")).toThrow("not registered");
    expect(() => clientMetadataFor("web", "https://evil.example/oidc-callback.html")).toThrow("not registered");
    expect(() => clientMetadataFor("desktop", "http://127.0.0.1:43123/elsewhere")).toThrow("not registered");
  });

  it("reads the answer from the fragment, only at the address it expects", () => {
    expect(callbackParams(`${ATPROTO_REDIRECTS.web}#state=s&code=c`, ATPROTO_REDIRECTS.web).get("code")).toBe("c");
    expect(callbackParams(`${ATPROTO_REDIRECTS.web}?state=s&error=access_denied`, ATPROTO_REDIRECTS.web).get("error")).toBe("access_denied");
    expect(() => callbackParams("https://evil.example/oidc-callback.html#code=c", ATPROTO_REDIRECTS.web)).toThrow("unexpected address");
  });
});

describe("publishing and deleting the record", () => {
  it("runs the sign-in for the typed account and writes one record keyed by the proof key, then revokes the session", async () => {
    const options = await flow();
    await publishAtprotoProof(statement, options);
    const client = lib.instances[0];
    expect(client.options.responseMode).toBe("fragment");
    expect(client.options.allowHttp).toBe(false);
    expect(client.options.clientMetadata.client_id).toBe(ATPROTO_CLIENT_METADATA.client_id);
    expect(client.authorized).toMatchObject({ input: alice.did, opts: { scope: ATPROTO_PROOF_SCOPE, redirect_uri: ATPROTO_REDIRECTS.web } });
    // The library resolves through Ghostly's own lookups: the document it gets is the directory's.
    expect(client.resolved).toMatchObject({ did: alice.did, handle: alice.handle, didDoc: { id: alice.did } });
    expect(options.log).toEqual([`authorize https://pds.example.com/oauth/authorize?client_id=x&request_uri=urn%3Areq ${"S".repeat(22)}`]);
    expect(client.params?.get("code")).toBe("c0de");
    const session = lib.session as ReturnType<typeof fakeSession>;
    expect(session.calls).toEqual([{ path: "/xrpc/com.atproto.repo.createRecord", body: {
      repo: alice.did, collection: ATPROTO_PROOF_COLLECTION, rkey: statement.binding.key,
      record: { $type: ATPROTO_PROOF_COLLECTION, statement: statement.text, createdAt: expect.any(String) },
    } }]);
    expect(session.signedOut).toBe(1);
  });

  it("deletes the record by the proof key", async () => {
    await unpublishAtprotoProof(statement.binding.key, await flow());
    const session = lib.session as ReturnType<typeof fakeSession>;
    expect(session.calls).toEqual([{ path: "/xrpc/com.atproto.repo.deleteRecord", body: { repo: alice.did, collection: ATPROTO_PROOF_COLLECTION, rkey: statement.binding.key } }]);
    expect(session.signedOut).toBe(1);
  });

  it("asks for full access only when told to", async () => {
    await publishAtprotoProof(statement, await flow({ access: "full" }));
    expect(lib.instances[0].authorized?.opts.scope).toBe(ATPROTO_FULL_SCOPE);
  });

  it("says so when the server does not offer the narrow permission", async () => {
    lib.authorizeError = Object.assign(new Error("invalid_scope"), { error: "invalid_scope" });
    await expect(publishAtprotoProof(statement, await flow())).rejects.toBeInstanceOf(AtprotoScopeError);
    lib.authorizeError = new Error("fetch failed");
    await expect(publishAtprotoProof(statement, await flow())).rejects.toThrow("refused to start the sign-in");
    lib.authorizeError = undefined;
    lib.session = fakeSession(alice.did, 403);
    await expect(publishAtprotoProof(statement, await flow())).rejects.toBeInstanceOf(AtprotoScopeError);
    lib.session = fakeSession(alice.did, 500);
    await expect(publishAtprotoProof(statement, await flow())).rejects.toThrow("did not publish the record (Nope: no)");
    expect((lib.session as ReturnType<typeof fakeSession>).signedOut).toBe(1);
  });

  it("refuses a login to another account, and still revokes that session", async () => {
    lib.session = fakeSession(net.account("mallory").did);
    await expect(publishAtprotoProof(statement, await flow())).rejects.toThrow("another account");
    const session = lib.session as ReturnType<typeof fakeSession>;
    expect(session.calls).toEqual([]);
    expect(session.signedOut).toBe(1);
  });

  it("explains a refusal on the server, and a failed exchange", async () => {
    const declined = fakeWindow(ATPROTO_REDIRECTS.web, state => `${ATPROTO_REDIRECTS.web}#state=${state}&error=access_denied`);
    await expect(publishAtprotoProof(statement, await flow({ window: declined.w }))).rejects.toThrow("You declined on your server");
    lib.callbackError = new Error("invalid_grant");
    await expect(publishAtprotoProof(statement, await flow())).rejects.toThrow("could not be completed");
  });

  it("stops when cancelled before signing in", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(publishAtprotoProof(statement, await flow({ signal: controller.signal }))).rejects.toThrow();
    expect(lib.instances).toHaveLength(0);
  });
});

describe("looking the account up", () => {
  it("takes a handle or a DID, and refuses a handle that does not point back", async () => {
    const lookup = (input: string) => lookupAtprotoAccount(input, { fetch: net.fetch, normalize: normalizeAtprotoHandle });
    expect((await lookup(`@${alice.handle.toUpperCase()}`)).did).toBe(alice.did);
    expect((await lookup(alice.did)).handle).toBe(alice.handle);
    await expect(lookup("not a handle")).rejects.toThrow("not a handle");
    await expect(lookup("nobody.example.com")).rejects.toThrow("does not point to an AT Protocol account");
    const liar = net.account("liar");
    liar.doc.alsoKnownAs = ["at://someone-else.example.com"];
    await expect(lookup(liar.handle)).rejects.toThrow("names another handle");
  });
});

describe("the provider's signers", () => {
  const ctxOf = (values: Record<string, string>, progress: string[] = []): SignerContext => ({ values, signal: new AbortController().signal, onAuthUrl: () => {}, onProgress: m => progress.push(m) });
  function host() {
    const events: string[] = [];
    const { w } = fakeWindow();
    const h: AtprotoHost = { platform: "web", open: () => { events.push("open"); return Promise.resolve({ ...w, close: () => events.push("close") }); } };
    return { h, events };
  }

  it("opens the window straight from the click, signs the statement for the account's DID, and closes it", async () => {
    const { h, events } = host();
    const provider = createAtprotoIdentityProvider({ host: () => h, fetch: net.fetch });
    const signer = provider.signers[0] as InAppSigner<AtprotoEvidence>;
    const progress: string[] = [];
    const running = signer.run(ctxOf({ handle: alice.handle }, progress), async session => {
      const subject = await session.subject();
      expect(subject).toBe(alice.did);
      return session.sign(identityStatement({ ...statement.binding, subject }));
    });
    // Before anything was awaited: a popup opened later would be blocked.
    expect(events).toEqual(["open"]);
    expect(await running).toEqual({});
    expect(events).toEqual(["open", "close"]);
    expect(progress[0]).toBe(`Looking up ${alice.handle}…`);
    expect(progress).toContain("Approve on pds.example.com in the window that opened…");
  });

  it("closes the window when the lookup fails, and is unavailable without a host", async () => {
    const { h, events } = host();
    const signer = createAtprotoIdentityProvider({ host: () => h, fetch: net.fetch }).signers[0] as InAppSigner<AtprotoEvidence>;
    await expect(signer.run(ctxOf({ handle: "nobody.example.com" }), async () => ({}))).rejects.toThrow("does not point");
    expect(events).toEqual(["open", "close"]);
    const none = createAtprotoIdentityProvider({ host: () => undefined }).signers[0] as InAppSigner<AtprotoEvidence>;
    expect(none.available?.()).toBe(false);
    await expect(none.run(ctxOf({ handle: alice.handle }), async () => ({}))).rejects.toThrow("not available here");
  });

  it("removes the record with a fresh approval, and asks for full access next time on a server that refused the narrow one", async () => {
    const { h, events } = host();
    const provider = createAtprotoIdentityProvider({ host: () => h, fetch: net.fetch });
    const proof = { id: statement.id, subject: alice.did, key: statement.binding.key };
    lib.session = fakeSession(alice.did, 403);
    await expect(provider.unpublish!.run(proof, ctxOf({}))).rejects.toThrow("only offers full access");
    expect(lib.instances[0].authorized?.opts.scope).toBe(ATPROTO_PROOF_SCOPE);
    lib.session = fakeSession(alice.did);
    await provider.unpublish!.run(proof, ctxOf({}));
    expect(lib.instances[1].authorized?.opts.scope).toBe(ATPROTO_FULL_SCOPE);
    expect((lib.session as ReturnType<typeof fakeSession>).calls[0].path).toBe("/xrpc/com.atproto.repo.deleteRecord");
    expect(events).toEqual(["open", "close", "open", "close"]);
  });
});
