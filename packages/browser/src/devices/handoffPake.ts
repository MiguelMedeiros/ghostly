import { fromBase64Url, handoffContextProof, toBase64Url } from "@ghostly/core";

/*
 * The password proof of a pull (WISP 06 § Authorizing a handoff): the taking device proves the profile's lock password
 * to the active one without sending it, and the active one keeps a verifier, never the password.
 *
 * The WISP names SPAKE2+ (RFC 9383) as a candidate and lets a reviewer prefer another augmented exchange with the same
 * binding and limits. This build uses OPAQUE (RFC 9807), through `@serenity-kit/opaque`, which is the Rust crate
 * `opaque-ke` (an earlier version of which NCC Group audited in 2021) compiled to WebAssembly, with ristretto255 and Argon2id. Why not SPAKE2+: no
 * maintained, reviewed JavaScript implementation of it exists, and writing one is writing a protocol from primitives.
 * OPAQUE is augmented as SPAKE2+ is (a stolen verifier still costs a dictionary attack), its three messages are the
 * WISP's three `handoff-pake` frames, and the password is stretched with Argon2id on the taker (memory-hard) where the
 * WISP had PBKDF2-SHA256.
 *
 * The verifier is the server's setup and the registration record, made on the active device while the person typed
 * the password (Add a device, a password changed). It moves with the profile: it lives in the profile's settings.
 *
 * Binding: OPAQUE's identifiers go into the envelope at registration, so they cannot name a session. The context
 * (`handoffContext`: the turn address, both device signing keys, the session's transcript hash) is bound twice instead:
 * the taker sends `HMAC(K, context)` with the third message (`handoffContextProof`), and `K` goes into the stream key
 * with the session's transcript hash as its salt.
 *
 * The library (about 430 KB with its WebAssembly) is loaded only when a handoff or a verifier needs it.
 */

type Opaque = typeof import("@serenity-kit/opaque");
let loading: Promise<Opaque> | null = null;
function opaque(): Promise<Opaque> {
  loading ??= import("@serenity-kit/opaque").then(async (module) => { await module.ready; return module; }).catch((error: unknown) => { loading = null; throw error; });
  return loading;
}

/** Every login and registration names this user: there is one password per profile. */
const USER = "ghostly-handoff";
const B64URL = /^[A-Za-z0-9_-]+$/;

/** What the active device keeps to check a pull's password. Secret: whoever holds it can answer as the active device. */
export interface HandoffVerifier {
  v: 1;
  /** The server's setup: its key pair and its OPRF seed. */
  setup: string;
  /** The registration record: the password's envelope and the client's public key. */
  record: string;
}

export function isHandoffVerifier(value: unknown): value is HandoffVerifier {
  const v = value as Partial<HandoffVerifier> | null;
  return !!v && typeof v === "object" && v.v === 1 && typeof v.setup === "string" && B64URL.test(v.setup) && typeof v.record === "string" && B64URL.test(v.record);
}

/** A verifier for this password: both halves of the registration, run on this device. */
export async function makeHandoffVerifier(password: string): Promise<HandoffVerifier> {
  if (!password) throw new Error("A password is needed");
  const { client, server } = await opaque();
  const setup = server.createSetup();
  const started = client.startRegistration({ password });
  const { registrationResponse } = server.createRegistrationResponse({ serverSetup: setup, userIdentifier: USER, registrationRequest: started.registrationRequest });
  const { registrationRecord } = client.finishRegistration({ clientRegistrationState: started.clientRegistrationState, registrationResponse, password });
  return { v: 1, setup, record: registrationRecord };
}

/** The password was wrong (the taker could not open the envelope), or the proof did not hold (the giver). */
export class HandoffPasswordError extends Error {
  constructor() {
    super("Wrong password");
    this.name = "HandoffPasswordError";
  }
}

/** The taker's side: the first message, then, from the second, the third, the context proof and the key. */
export interface PakeTaker {
  readonly first: string;
  /** Throws `HandoffPasswordError` when the password is wrong. Once only. */
  finish(second: string, context: Uint8Array): Promise<{ third: string; proof: string; key: Uint8Array }>;
}

export async function startPakeTaker(password: string): Promise<PakeTaker> {
  const { client } = await opaque();
  const { clientLoginState, startLoginRequest } = client.startLogin({ password });
  let used = false;
  return {
    first: startLoginRequest,
    async finish(second, context) {
      if (used) throw new Error("The password proof was already finished");
      used = true;
      let result: ReturnType<Opaque["client"]["finishLogin"]>;
      try { result = client.finishLogin({ clientLoginState, loginResponse: second, password }); } catch { throw new HandoffPasswordError(); }
      if (!result) throw new HandoffPasswordError();
      const key = fromBase64Url(result.sessionKey);
      return { third: result.finishLoginRequest, proof: toBase64Url(handoffContextProof(key, context)), key };
    },
  };
}

/** The giver's side: the second message, then, from the third and the context proof, the key. */
export interface PakeGiver {
  readonly second: string;
  /** The key, or a `HandoffPasswordError` when the third message or the context proof does not hold. Once only: a replayed third message is refused. */
  finish(third: string, proof: string, context: Uint8Array): Promise<Uint8Array>;
}

export async function startPakeGiver(verifier: HandoffVerifier, first: string): Promise<PakeGiver> {
  if (!isHandoffVerifier(verifier)) throw new Error("This profile has no password proof to check against");
  const { server } = await opaque();
  let started: ReturnType<Opaque["server"]["startLogin"]>;
  try { started = server.startLogin({ serverSetup: verifier.setup, registrationRecord: verifier.record, startLoginRequest: first, userIdentifier: USER }); } catch { throw new HandoffPasswordError(); }
  let state: string | null = started.serverLoginState;
  return {
    second: started.loginResponse,
    async finish(third, proof, context) {
      // The state answers one third message: a replay of it, or a second try on the same second message, is refused.
      const serverLoginState = state;
      state = null;
      if (!serverLoginState) throw new HandoffPasswordError();
      let key: Uint8Array;
      try { key = fromBase64Url(server.finishLogin({ finishLoginRequest: third, serverLoginState }).sessionKey); } catch { throw new HandoffPasswordError(); }
      const expected = toBase64Url(handoffContextProof(key, context));
      if (expected !== proof) throw new HandoffPasswordError();
      return key;
    },
  };
}
