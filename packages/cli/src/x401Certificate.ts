import { X509Certificate } from "node:crypto";
import * as tls from "node:tls";
import { fromBase64Url, type X401CertificateCheck } from "@ghostly/core";

/**
 * The certificate check of a signed x401 request (WISP 3xx, step 3) on Node: the `x5c` chain, leaf first, leads to one
 * of the trusted roots (Node's default store: its bundled roots plus NODE_EXTRA_CA_CERTS), every certificate is valid
 * now, each one after the leaf is a CA and signed the one before it, and a DNS name in the leaf's subjectAltName is the
 * host called (never its subject's common name). The leaf's key must be P-256.
 */
export function x401CertificateCheck(roots: readonly string[] = defaultRoots()): X401CertificateCheck {
  let trusted: X509Certificate[] | undefined;
  return async (chain, host, now) => {
    const refuse = (reason: string) => ({ ok: false as const, reason });
    let certs: X509Certificate[];
    try { certs = chain.map((der) => new X509Certificate(der)); } catch { return refuse("a certificate does not parse"); }
    for (const cert of certs) {
      if (Date.parse(cert.validFrom) > now || Date.parse(cert.validTo) < now) return refuse(`a certificate is not valid now (${cert.subject.replace(/\n/g, ", ")})`);
    }
    const [leaf] = certs;
    if (leaf.ca) return refuse("the leaf certificate is a CA");
    if (leaf.checkHost(host, { subject: "never" }) === undefined) return refuse(`the leaf certificate does not name ${host}`);
    for (let i = 0; i + 1 < certs.length; i++) {
      const child = certs[i], parent = certs[i + 1];
      if (!parent.ca || !child.checkIssued(parent) || !child.verify(parent.publicKey)) return refuse("the chain does not link");
    }
    trusted ??= roots.flatMap((pem) => { try { return [new X509Certificate(pem)]; } catch { return []; } });
    const last = certs[certs.length - 1];
    const anchored = trusted.some((root) => root.fingerprint256 === last.fingerprint256 ||
      (root.ca && Date.parse(root.validTo) >= now && last.checkIssued(root) && last.verify(root.publicKey)));
    if (!anchored) return refuse("the chain leads to no trusted root");
    const key = leaf.publicKey;
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") return refuse("the leaf key is not P-256");
    const jwk = key.export({ format: "jwk" });
    if (typeof jwk.x !== "string" || typeof jwk.y !== "string") return refuse("the leaf key is not P-256");
    const publicKey = new Uint8Array(65);
    publicKey[0] = 4;
    publicKey.set(fromBase64Url(jwk.x), 1);
    publicKey.set(fromBase64Url(jwk.y), 33);
    return { ok: true, publicKey };
  };
}

function defaultRoots(): readonly string[] {
  const read = (tls as { getCACertificates?: (type?: string) => string[] }).getCACertificates;
  return read ? read("default") : tls.rootCertificates;
}
