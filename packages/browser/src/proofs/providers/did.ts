import {
  checkDidJws, checkDidSignature, DidError, DID_JWS_MAX_LENGTH, didGhostlyServiceEntry, didJwsAlg, didSignedMessages, didWebFile, didWebFileNames,
  didWebFileUrl, normalizeDid, parseDid, parseDidSignaturePaste, signingKeys, staticDidDocument, strictBase64Url, toBase64Url,
  type DidCurve, type DidKey, type IdentityStatement,
} from "@ghostly/core";
import type { ExternalToolSigner, IdentityProofProvider, PublishSigner, SignerInstructions, SubjectPreview } from "../contract";
import { fetchDidWebFile, lastDidResolution, resolveDid, type DidResolution } from "../did";
import { boundedIdentityFetch } from "../verify";

/**
 * A decentralized identifier (W3C DID Core), draft WISP 3xx-did. The subject is the DID; the statement is
 * vouched for by a key its document lists under `authentication` or `assertionMethod` (a JWS or a raw
 * signature pasted back, like SSH and PGP), or, for did:web, by publishing it where the DID document lives
 * (a file beside did.json, or a service entry in it), like the domain proof.
 *
 * Methods: did:key and did:jwk (the key is the identifier: checked offline), did:dht (a signed Pkarr
 * record), did:web (HTTPS). Every check resolves the DID again, so a key removed from a did:web or did:dht
 * document stops counting at the contact's next check.
 */

export type DidEvidence =
  | { method: "jws"; vm: string; jws: string }
  | { method: "sig"; vm: string; sig: string }
  | { method: "file" }
  | { method: "service" };

const VM = /^did:[a-z0-9]+:[\x21-\x7e]+#[\x21-\x7e]+$/;
const SIG = /^[A-Za-z0-9_-]{86}$/;
const exactKeys = (raw: unknown, keys: string) => !!raw && typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw).sort().join(",") === keys;
const validVm = (vm: unknown): vm is string => typeof vm === "string" && vm.length <= 640 && VM.test(vm);

/** The profile's own Ghostly did:dht, refused as an external identity. The UI and the engine each set where to read it. */
let ownDid: () => string | undefined = () => undefined;
export function setOwnDidSource(source: () => string | undefined): void { ownDid = source; }

/** The add dialog's checks run in the UI, with the same bounded fetch the engine uses. */
const uiFetch = boundedIdentityFetch({ online: () => globalThis.navigator?.onLine !== false });

/** `#key-1`, shortened when a multibase fragment is long. */
const fragment = (id: string) => {
  const f = id.slice(id.indexOf("#"));
  return f.length > 20 ? `${f.slice(0, 11)}…${f.slice(-4)}` : f;
};

function shortDid(did: string): string {
  if (did.length <= 30) return did;
  const { method, id } = parseDidSafe(did);
  if (method === "web") return `did:web:${id.split(":")[0]}${id.includes(":") ? ":…" : ""}`;
  return `did:${method}:${id.slice(0, 8)}…${id.slice(-4)}`;
}
const parseDidSafe = (did: string) => { try { return parseDid(did); } catch { return { did, method: did.split(":")[1] ?? "", id: did.split(":").slice(2).join(":") }; } };

/** Keys the instructions can name before anything is fetched: the identifier's own, or what the preview resolved. */
function knownKeys(did: string): DidKey[] {
  const { method } = parseDid(did);
  if (method === "key" || method === "jwk") return signingKeys(staticDidDocument(did));
  const seen = lastDidResolution(did);
  return seen ? signingKeys(seen.document) : [];
}

const NOBLE: Record<DidCurve, { name: string; module: string }> = {
  Ed25519: { name: "ed25519", module: "ed25519.js" },
  secp256k1: { name: "secp256k1", module: "secp256k1.js" },
  "P-256": { name: "p256", module: "nist.js" },
};

function joseScript(statement: string, kid?: string): string {
  return [
    "// npm install jose; then: node sign.mjs your-private-key.jwk.json",
    "import { readFileSync } from \"node:fs\";",
    "import { CompactSign, importJWK } from \"jose\";",
    `const statement = ${JSON.stringify(statement)};`,
    "const jwk = JSON.parse(readFileSync(process.argv[2], \"utf8\"));",
    "const alg = { Ed25519: \"EdDSA\", \"P-256\": \"ES256\" }[jwk.crv];",
    "const jws = await new CompactSign(new TextEncoder().encode(statement))",
    `  .setProtectedHeader({ alg${kid ? `, kid: ${JSON.stringify(kid)}` : ""} })`,
    "  .sign(await importJWK(jwk, alg));",
    "console.log(jws);",
  ].join("\n");
}

function nobleScript(statement: string, curve: DidCurve): string {
  const lib = NOBLE[curve];
  return [
    "// npm install @noble/curves; then: node sign.mjs your-private-key.hex",
    "import { readFileSync } from \"node:fs\";",
    `import { ${lib.name} } from "@noble/curves/${lib.module}";`,
    `const statement = new TextEncoder().encode(${JSON.stringify(statement)});`,
    "const secret = Uint8Array.from(Buffer.from(readFileSync(process.argv[2], \"utf8\").trim(), \"hex\"));",
    `console.log(Buffer.from(${lib.name}.sign(statement, secret)).toString("hex"));`,
  ].join("\n");
}

function opensslCommand(statement: string, curve: DidCurve): string {
  const save = `printf '%s' '${statement}' > statement.txt`;
  return curve === "Ed25519"
    ? `${save} && openssl pkeyutl -sign -rawin -inkey key.pem -in statement.txt | xxd -p | tr -d '\\n'`
    : `${save} && openssl dgst -sha256 -sign key.pem statement.txt | xxd -p | tr -d '\\n'`;
}

const signer: ExternalToolSigner<DidEvidence> = {
  id: "sign", kind: "external-tool", label: "Sign with a key of the DID",
  description: "Sign the statement with a key your DID document lists for authentication or assertionMethod, and paste a JWS or the raw signature. The private key never enters Ghostly.",
  instructions(statement): SignerInstructions {
    const did = statement.binding.subject;
    if (statement.text.includes("'")) throw new DidError("Statement is not signable as plain text");
    const keys = knownKeys(did);
    const key = keys.length === 1 ? keys[0] : undefined;
    const curve = key?.curve ?? keys[0]?.curve ?? "Ed25519";
    const which = keys.length ? keys.map(k => `${fragment(k.id)} (${k.curve})`).join(", ") : "a key listed under authentication or assertionMethod";
    return {
      steps: [
        { text: `Sign this statement with the private key of ${which}. It is one line, with no newline at the end:`, copy: statement.text },
        ...(curve === "secp256k1" ? [] : [{ text: `With jose (Node.js 20 or later), a JWS: save this as sign.mjs and run it with your ${curve} private key as a JWK file.`, copy: joseScript(statement.text, key?.id) }]),
        { text: `With @noble/curves (Node.js), a raw signature: save this as sign.mjs and run it with your ${curve} private key in hex.`, copy: nobleScript(statement.text, curve) },
        { text: `Or with OpenSSL 3 and your ${curve} key in PEM:`, copy: opensslCommand(statement.text, curve) },
        { text: `Paste what it prints: a compact JWS (${didJwsAlg(curve)}, attached or detached), or the signature in hex or base64. If your DID lists several keys, you may write the key id first: #key-1 <signature>.` },
      ],
      paste: { label: "JWS or signature", placeholder: "eyJhbGciOi… or the signature in hex", multiline: true },
    };
  },
  async parse(pasted, statement) {
    const did = statement.binding.subject;
    const paste = parseDidSignaturePaste(pasted);
    const { document } = await resolveDid(did, { fetch: uiFetch });
    const messages = didSignedMessages(statement.text);
    if (paste.kind === "jws") return { method: "jws", vm: checkDidJws(paste.jws, messages, document).key.id, jws: paste.jws };
    const check = checkDidSignature(paste.signature, messages, document, paste.vm);
    return { method: "sig", vm: check.key.id, sig: toBase64Url(check.signature) };
  },
};

const webOnly = (statement: IdentityStatement) => {
  const did = statement.binding.subject;
  if (parseDid(did).method !== "web") throw new DidError("Publishing works for did:web only: sign the statement instead");
  return did;
};

const fileSigner: PublishSigner<DidEvidence> = {
  id: "file", kind: "publish", label: "Publish a file beside did.json",
  description: "did:web only: upload a small file next to your did.json. Contacts' apps download both from your server.",
  instructions(statement) {
    const did = webOnly(statement);
    return { steps: [
      { text: "Create this file on your web server, beside your did.json:", copy: didWebFileUrl(did, statement.id) },
      { text: "With exactly this content:", copy: didWebFile(did, statement.text) },
      { text: "Serve it over HTTPS at exactly that address, without any redirect, and with this header so browsers may read it (your did.json needs it too):", copy: "Access-Control-Allow-Origin: *" },
      { text: "Then press Check. The file stays public while the proof is in use; deleting it withdraws this proof from every contact at their next check." },
    ] };
  },
  evidence: () => ({ method: "file" }),
};

const serviceSigner: PublishSigner<DidEvidence> = {
  id: "service", kind: "publish", label: "Add a service to did.json",
  description: "did:web only: add one entry to the service list of your did.json. Contacts' apps read it there.",
  instructions(statement) {
    const did = webOnly(statement);
    const seen = lastDidResolution(did);
    return { steps: [
      { text: `Add this entry to the "service" list of your did.json${seen?.documentUrl ? ` (${seen.documentUrl})` : ""}:`, copy: JSON.stringify(didGhostlyServiceEntry(did, statement.binding.key, statement.id), null, 2) },
      { text: "Then press Check. Removing the entry withdraws this proof from every contact at their next check." },
    ] };
  },
  evidence: () => ({ method: "service" }),
};

function previewOf(r: DidResolution): SubjectPreview {
  const keys = signingKeys(r.document);
  const unusable = r.document.keys.length - keys.length + r.document.skipped;
  if (!keys.length && r.method !== "web") throw new DidError("This DID lists no Ed25519, secp256k1 or P-256 key for authentication or assertionMethod, so it cannot sign");
  const facts: { label: string; value: string }[] = [{ label: "Method", value: `did:${r.method}${r.method === "key" || r.method === "jwk" ? ", the key is the identifier" : ""}` }];
  if (r.host) facts.push({ label: "Domain", value: r.host });
  if (r.documentUrl) facts.push({ label: "Document", value: r.documentUrl });
  if (r.relay) facts.push({ label: "Relay", value: r.relay.replace(/^https:\/\//, "") });
  facts.push({ label: keys.length === 1 ? "Key" : "Keys", value: keys.length ? keys.map(k => `${fragment(k.id)} (${k.curve})`).join(", ") : "none that can sign: publish instead" });
  if (unusable > 0) facts.push({ label: "Not usable", value: `${unusable} ${unusable === 1 ? "key" : "keys"}: another curve, or not for authentication or assertionMethod` });
  return { facts, signers: r.method === "web" ? [...(keys.length ? ["sign"] : []), "file", "service"] : ["sign"] };
}

export const did: IdentityProofProvider<DidEvidence> = {
  id: "did",
  label: "DID",
  category: "self-custodied",
  summary: "did:key, did:jwk, did:dht or did:web",
  description: "Proves you control a decentralized identifier (W3C DID): sign the statement with a key its DID document lists, or, for did:web, publish it beside your did.json.",
  limits: "Does not prove who controls the DID, only that whoever added the proof held one of its keys (or its website).",
  platforms: ["web", "extension", "desktop"],
  advanced: true,
  experimental: true,
  subject: {
    label: "DID", placeholder: "did:key:z6Mk… or did:web:example.com",
    help: "did:key, did:jwk, did:dht or did:web. Contacts see the whole DID, and the key that signed.",
    normalize(input) {
      const canonical = normalizeDid(input);
      if (canonical === ownDid()) throw new DidError("That is this profile's own Ghostly DID: your contacts already see your Ghostly identity. Add another DID.");
      return canonical;
    },
    short: shortDid,
    preview: async (subject, { signal }) => previewOf(await resolveDid(subject, { fetch: uiFetch, signal })),
  },
  // A proven DID is already a URI: the profile's own did:dht may list it under alsoKnownAs.
  publicUri: subject => subject,
  validity: { defaultDays: 90, maxDays: 365 },
  // A did:web or did:dht document can drop a key, or the file be deleted: contacts can check again.
  recheck: { afterSeconds: 86_400 },
  privacy: "did:key and did:jwk: nothing, checked on this device. did:web: the contact's app asks its DNS-over-HTTPS resolver for your domain and downloads your did.json, " +
    "so your web server sees the contact's IP address. did:dht: a Pkarr relay learns which DID was looked up.",
  signers: [signer, fileSigner, serviceSigner],
  parseEvidence(raw) {
    const e = raw as Record<string, unknown>;
    if (exactKeys(raw, "jws,method,vm") && e.method === "jws" && typeof e.jws === "string" && e.jws.length <= DID_JWS_MAX_LENGTH && validVm(e.vm)) return { method: "jws", vm: e.vm, jws: e.jws };
    if (exactKeys(raw, "method,sig,vm") && e.method === "sig" && typeof e.sig === "string" && SIG.test(e.sig) && validVm(e.vm)) return { method: "sig", vm: e.vm, sig: e.sig };
    if (exactKeys(raw, "method") && (e.method === "file" || e.method === "service")) return { method: e.method };
    throw new Error("That is not DID proof evidence");
  },
  async verify(statement, evidence, ctx) {
    const subject = statement.binding.subject;
    const { method } = parseDid(subject);
    if (normalizeDid(subject) !== subject) throw new DidError("The DID is not in canonical form");
    if ((evidence.method === "file" || evidence.method === "service") && method !== "web") throw new DidError("Only a did:web can publish its proof");
    const options = { fetch: ctx.fetch, signal: ctx.signal, now: () => ctx.now * 1000 };
    const { document, host } = await resolveDid(subject, options);
    const messages = didSignedMessages(statement.text);
    if (evidence.method === "jws" || evidence.method === "sig") {
      const check = evidence.method === "jws"
        ? checkDidJws(evidence.jws, messages, document)
        : checkDidSignature(strictBase64Url(evidence.sig), messages, document, evidence.vm);
      if (check.key.id !== evidence.vm) throw new DidError("Signed by another key than the proof names");
      return { subject, source: `did:${method} · ${evidence.method === "jws" ? `${check.alg} JWS` : `${check.alg} signature`} by ${fragment(check.key.id)}` };
    }
    if (evidence.method === "service") {
      if (!document.services.some(s => s.proof === statement.id && s.key === statement.binding.key)) throw new DidError("The did.json has no Ghostly service for this proof: it was removed, or not added yet");
      return { subject, source: `did:web · service in the did.json of ${host}` };
    }
    const text = await fetchDidWebFile(subject, statement.id, options);
    if (text === undefined) throw new DidError(`${didWebFileUrl(subject, statement.id)} was not found: it was deleted, or not uploaded yet`);
    if (!didWebFileNames(text, subject, statement.text)) throw new DidError(`${didWebFileUrl(subject, statement.id)} is not the statement of this proof`);
    return { subject, source: `did:web · statement file beside the did.json of ${host}` };
  },
};
