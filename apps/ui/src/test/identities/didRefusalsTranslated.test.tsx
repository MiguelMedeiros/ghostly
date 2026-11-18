import { screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newIdentityBinding } from "@ghostly/core";
import { clearDidCache } from "@ghostly/browser/proofs/did";
import { setPkarrRelaySource } from "@ghostly/browser/proofs/pkarrRelays";
import { AddIdentityDialog } from "../../components/identities/AddIdentityDialog";
import { knownErrorText } from "../../lib/errorText";
import { receivedRefusal } from "../../lib/identities";
import { problemLine, problemText } from "../../lib/problemText";
import { translateWith } from "../../locales/translate";
import { LANGUAGES, LOCALES } from "../i18n/locales";
import { renderApp } from "../render";

// covers: proofs.did, app.i18n

/*
 * Why a DID, its document or a signature made with it is refused is the engine's English (packages/core did.ts and
 * didDht.ts, packages/browser proofs/did.ts and proofs/providers/did.ts). Forty of those lines came out in English in
 * every language: Add's preview, its signature step, a contact's check. Every one these files throw is read here from
 * the source, so a new refusal that the app does not say in the language fails this test.
 */

const ROOT = join(fileURLToPath(import.meta.url), "../../../../../..");
const SOURCES = [
  "packages/core/src/did.ts",
  "packages/core/src/didDht.ts",
  "packages/browser/src/proofs/did.ts",
  "packages/browser/src/proofs/providers/did.ts",
] as const;
const source = (path: string) => readFileSync(join(ROOT, path), "utf8");

/** Every fixed text thrown as a DidError or DidDhtError: the argument itself, or the fixed side of a `? … : "…"`. */
function fixedRefusals(): string[] {
  const found = SOURCES.flatMap((path) => {
    const text = source(path);
    return [
      ...[...text.matchAll(/new (?:DidDhtError|DidError)\("([^"]+)"/g)].map((m) => m[1]!),
      ...[...text.matchAll(/new (?:DidDhtError|DidError)\([^;\n]*? : "([^"]+)"\)/g)].map((m) => m[1]!),
    ];
  });
  return [...new Set(found)];
}

/** Every text built with values (a template literal): its fixed parts, as a pattern a sample must fit. */
function builtRefusals(): { template: string; pattern: RegExp }[] {
  return SOURCES.flatMap((path) => [...source(path).matchAll(/new (?:DidDhtError|DidError)\(`((?:[^`\\]|\\.)*)`/g)].map((m) => {
    const template = m[1]!;
    const parts = template.split(/\$\{(?:[^{}]|\{[^}]*\})*\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return { template, pattern: new RegExp(`^${parts.join("[\\s\\S]+")}$`) };
  }));
}

/** A thrown example of each built text, with values as the engine fills them. */
const SAMPLES = [
  "That DID is too long (at most 2048 characters)",
  "Write the method in lowercase: did:web:…",
  "did:plc is not supported yet. Ghostly checks did:key, did:jwk, did:dht and did:web.",
  "did:web: That is not a valid domain name",
  "That P-256 key is not a valid point",
  "That secp256k1 JWK is malformed",
  "The DID document's verificationMethod is not a list",
  "The DID document is for another DID (did:web:other.example)",
  "The JWS uses another algorithm: Ghostly checks EdDSA, ES256K and ES256",
  "The JWS uses no algorithm: Ghostly checks EdDSA, ES256K and ES256",
  "A ES256K signature is 64 bytes",
  "The JWS names a key that is not a key of did:web:example.com",
  "The key the JWS names is not a P-256 key: the JWS says ES256K",
  "The DID document lists no Ed25519 key for EdDSA",
  "The proof names a key that is not a key of did:web:example.com",
  "The did:dht document is malformed: a key is listed twice",
  "https://example.com/.well-known/did.json is too large",
  "https://example.com/.well-known/did.json is not text",
  "No DID document at https://example.com/.well-known/did.json",
  "https://example.com/.well-known/did.json is not JSON",
  "https://example.com/.well-known/ghostly/0a1b.txt was not found: it was deleted, or not uploaded yet",
  "https://example.com/.well-known/ghostly/0a1b.txt is not the statement of this proof",
];

/** Built texts no person meets: the local resolver asked for a DID it never takes (a bug, not an input). */
const NOT_SAID = new Set(["did:${parsed.method} is resolved over the network"]);

const others = LANGUAGES.filter((language) => language !== "en");

describe("every DID refusal is said in the app's language", () => {
  const fixed = fixedRefusals();

  it("reads them from the sources", () => {
    // 60 when this test was written: far fewer means the pattern no longer finds them.
    expect(fixed.length).toBeGreaterThanOrEqual(60);
    expect(fixed).toContain("No document is published for this did:dht");
    expect(fixed).toContain("The DID document has no id");
  });

  it("has a sample of every refusal built with values", () => {
    const missing = builtRefusals().filter(({ template, pattern }) => !NOT_SAID.has(template) && !SAMPLES.some((s) => pattern.test(s)));
    expect(missing.map(({ template }) => template)).toEqual([]);
  });

  it.each(others)("in %s, none of them in English", (language) => {
    const t = translateWith(LOCALES[language], language);
    const english = [...fixed, ...SAMPLES].filter((text) => {
      const line = problemLine(new Error(text), t);
      return line === text || line.includes(text);
    });
    expect(english).toEqual([]);
  });

  it("in Portuguese, the lines the issue named", () => {
    const t = translateWith(LOCALES.pt, "pt");
    expect(problemLine(new Error("No document is published for this did:dht"), t)).toBe("Nenhum documento foi publicado para este did:dht");
    expect(problemLine(new Error("The JWS carries another text: sign exactly the statement shown"), t)).toBe("O JWS traz outro texto: assine exatamente a declaração mostrada");
    expect(problemLine(new Error("That is not a signature: paste a JWS, or a signature in hex or base64"), t)).toBe("Isso não é uma assinatura: cole um JWS, ou uma assinatura em hex ou base64");
    expect(problemLine(new Error("did:web: that port is not valid"), t)).toBe("did:web: essa porta não é válida");
    expect(problemLine(new Error("The DID document lists no Ed25519 key for EdDSA"), t)).toBe("O documento DID não lista nenhuma chave Ed25519 para EdDSA");
    expect(problemLine(new Error("A signature is 64 bytes (or DER, for ECDSA)"), t)).toBe("Uma assinatura tem 64 bytes (ou DER, para ECDSA)");
    expect(problemLine(new Error("Only a did:web can publish its proof"), t)).toBe("Só um did:web pode publicar sua prova");
  });

  it("in Arabic and Japanese, a few of them", () => {
    const ar = translateWith(LOCALES.ar, "ar");
    const ja = translateWith(LOCALES.ja, "ja");
    expect(problemLine(new Error("No document is published for this did:dht"), ar)).toBe("لم يُنشر أي مستند لهذا الـ did:dht");
    expect(problemLine(new Error("Paste the signature"), ar)).toBe("الصق التوقيع");
    expect(problemLine(new Error("No document is published for this did:dht"), ja)).toBe("この did:dht にはドキュメントが公開されていません");
    expect(problemLine(new Error("Signed by a key the DID document does not list under authentication or assertionMethod"), ja))
      .toBe("DID ドキュメントの authentication にも assertionMethod にも載っていない鍵で署名されています");
  });

  it("keeps what a malformed document or another DID names out of the line, behind the ⓘ", () => {
    const t = translateWith(LOCALES.pt, "pt");
    const malformed = "The did:dht document is malformed: a key is listed twice";
    expect(problemText(new Error(malformed), t)).toEqual({ tone: "error", title: "O documento did:dht está malformado", detail: malformed });
    const other = "The JWS names a key that is not a key of did:web:example.com";
    expect(problemText(new Error(other), t)).toEqual({ tone: "error", title: "O JWS indica uma chave que não é deste DID", detail: other });
  });

  it("on a contact's check too, where the reason was a generic line", () => {
    const t = translateWith(LOCALES.pt, "pt");
    expect(receivedRefusal("The did:dht record is not signed by the DID's key", t)).toBe("O registro did:dht não foi assinado pela chave do DID");
  });

  it("in English, says the ones errorText.ts does not know as the engine wrote them", () => {
    const changed = fixed.filter((text) => !knownErrorText(text) && problemLine(new Error(text)) !== text);
    expect(changed).toEqual([]);
  });
});

describe("Add → DID says the refusal in the language", () => {
  const DHT = "did:dht:cyuoqaf7itop8ohww4yn5ojg13qaq83r9zihgqntc5i9zwrfdfoo";
  const DID_KEY = "did:key:z6MkiTBz1ymuepAQ4HEHYSF1H8quG5GLVVQR3djdX3mDooWp";
  afterEach(() => { vi.unstubAllGlobals(); setPkarrRelaySource(() => undefined); clearDidCache(); });

  it("in Arabic, a did:dht one relay has no document for and the other does not answer", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) => String(url).startsWith("https://relay-a.test")
      ? Promise.resolve(new Response("", { status: 404 }))
      : Promise.reject(new TypeError("Failed to fetch"))));
    setPkarrRelaySource(() => ["https://relay-a.test", "https://relay-b.test"]);
    const { user } = renderApp(<AddIdentityDialog onClose={vi.fn()} />, { language: "ar" });
    await user.click(screen.getByTestId("add-identity-advanced"));
    await user.click(screen.getByTestId("add-identity-did"));
    await user.type(screen.getByTestId("add-identity-subject"), DHT);
    expect(await screen.findByTestId("add-identity-preview-error", {}, { timeout: 5000 })).toHaveTextContent("لم يُنشر أي مستند لهذا الـ did:dht");
  });

  it("in Portuguese, a JWS signed over another text", async () => {
    const { user, engine } = renderApp(<AddIdentityDialog onClose={vi.fn()} />, { language: "pt" });
    engine.on("beginIdentityProof", () => ({ draftId: "d1", binding: newIdentityBinding({ provider: "did", subject: DID_KEY, validitySeconds: 90 * 86400 }).binding }));
    engine.on("completeIdentityProof", () => { throw new Error("The JWS carries another text: sign exactly the statement shown"); });
    await user.click(screen.getByTestId("add-identity-advanced"));
    await user.click(screen.getByTestId("add-identity-did"));
    await user.type(screen.getByTestId("add-identity-subject"), DID_KEY);
    await vi.waitFor(() => expect(screen.getByTestId("add-identity-start")).not.toBeDisabled(), { timeout: 3000 });
    await user.click(screen.getByTestId("add-identity-start"));
    const b64 = (s: string) => btoa(s).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    await user.click(await screen.findByTestId("add-identity-paste"));
    await user.paste(`${b64(JSON.stringify({ alg: "EdDSA" }))}.${b64("another text")}.${b64("y".repeat(64))}`);
    await user.click(screen.getByTestId("add-identity-finish"));
    expect(await screen.findByTestId("add-identity-error")).toHaveTextContent("O JWS traz outro texto: assine exatamente a declaração mostrada");
  });
});
