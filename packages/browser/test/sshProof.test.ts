import { describe, expect, it } from "vitest";
import { identityStatement, newIdentityBinding, parseSshPublicKey, type IdentityStatement } from "@ghostly/core";
import type { ExternalToolSigner, IdentityFetch, IdentityProofProvider, VerifyContext } from "../src/proofs/contract";
import { ssh, sshGithub, sshGitlab, type SshEvidence } from "../src/proofs/providers/ssh";
import { IDENTITY_PROVIDERS } from "../src/proofs/registry";
import { verifyIdentity } from "../src/proofs/verify";
import { describeIdentityProof } from "./helpers/identityProofContract";
import { sshTestKey } from "./helpers/sshKeygen";
// covers: proofs.ssh, proofs.ssh.github, proofs.ssh.gitlab, proofs.contract

// Keys come from the real ssh-keygen, the tool the instructions tell people to run.
const mine = sshTestKey(), other = sshTestKey("ecdsa"), stranger = sshTestKey(), rsa = sshTestKey("rsa");
const fingerprint = parseSshPublicKey(mine.publicKey).fingerprint;
const signer = (p: IdentityProofProvider<SshEvidence>) => p.signers[0] as ExternalToolSigner<SshEvidence>;
const proveWith = (p: IdentityProofProvider<SshEvidence>, key = mine) => async (s: IdentityStatement) => signer(p).parse(key.sign(s.text), s);

/** api.github.com and gitlab.com as a map of account → published key lines; nothing else answers. */
function forges(published: Record<string, string[]>) {
  const calls: string[] = [];
  const reply = (status: number, body: unknown) => { const text = JSON.stringify(body); return { status, contentType: "application/json", text, bytes: new TextEncoder().encode(text) }; };
  const fetch: IdentityFetch = async url => {
    calls.push(url);
    const gh = /^https:\/\/api\.github\.com\/users\/([^/]+)\/keys\?per_page=100$/.exec(url);
    if (gh) return published[`github:${gh[1]}`] ? reply(200, published[`github:${gh[1]}`].map((key, id) => ({ id, key }))) : reply(404, { message: "Not Found" });
    const user = /^https:\/\/gitlab\.com\/api\/v4\/users\?username=(.+)$/.exec(url);
    if (user) return reply(200, published[`gitlab:${user[1]}`] ? [{ id: 4242, username: user[1] }] : []);
    const keys = /^https:\/\/gitlab\.com\/api\/v4\/users\/4242\/keys\?per_page=100$/.exec(url);
    if (keys) return reply(200, Object.entries(published).find(([k]) => k.startsWith("gitlab:"))?.[1].map(key => ({ key })) ?? []);
    throw new Error(`Unexpected network access: ${url}`);
  };
  return { fetch, calls, published };
}

describeIdentityProof("SSH key", async () => ({ provider: ssh, subject: fingerprint, prove: proveWith(ssh), proveAsOther: async s => ({ signature: other.sign(s.text) }) }), { timeout: 20_000 });

for (const provider of [sshGithub, sshGitlab]) {
  const forge = provider.id.slice(4);
  describeIdentityProof(provider.label, async () => {
    const net = forges({ [`${forge}:octo-cat`]: [parseSshPublicKey(other.publicKey).line, mine.publicKey] });
    return { provider, subject: "octo-cat", fetch: net.fetch, prove: proveWith(provider), proveAsOther: proveWith(provider, stranger),
      revoke: () => { net.published[`${forge}:octo-cat`] = [other.publicKey]; } };
  }, { timeout: 20_000 });
}

const ctx = (fetch: IdentityFetch = async url => { throw new Error(`Unexpected network access: ${url}`); }): VerifyContext =>
  ({ now: Math.floor(Date.now() / 1000), signal: new AbortController().signal, fetch });
const statementFor = (provider: IdentityProofProvider<SshEvidence>, subject: string) =>
  identityStatement(newIdentityBinding({ provider: provider.id, subject, validitySeconds: 90 * 86_400 }).binding);
const verify = (provider: IdentityProofProvider<SshEvidence>, s: IdentityStatement, evidence: unknown, fetch?: IdentityFetch) =>
  verifyIdentity([provider as IdentityProofProvider], s, evidence, ctx(fetch));

describe("SSH identity proofs", () => {
  it("is registered, once each", () => {
    expect(IDENTITY_PROVIDERS.filter(p => p.id.startsWith("ssh")).map(p => p.id)).toEqual(["ssh", "ssh-github", "ssh-gitlab"]);
  });

  it("shows the exact command and statement to copy, and a paste field", () => {
    const s = statementFor(ssh, fingerprint);
    const steps = signer(ssh).instructions(s);
    expect(steps.steps[0].copy).toBe(`printf '%s' '${s.text}' | ssh-keygen -Y sign -n ghostly -f ~/.ssh/id_ed25519`);
    expect(steps.steps[1].copy).toBe(s.text);
    expect(steps.paste).toMatchObject({ multiline: true, placeholder: "-----BEGIN SSH SIGNATURE-----" });
    expect(signer(sshGithub).description).toMatch(/GitHub account lists/);
  });

  it("takes a .pub line or a fingerprint as the subject", () => {
    expect(ssh.subject.normalize(`  ${mine.publicKey} me@laptop \n`)).toBe(fingerprint);
    expect(ssh.subject.normalize(fingerprint)).toBe(fingerprint);
    expect(() => ssh.subject.normalize("-----BEGIN OPENSSH PRIVATE KEY-----")).toThrow(/Paste your public key/);
    expect(() => ssh.subject.normalize("ssh-dss AAAAB3NzaC1kc3MAAAA=")).toThrow(/Unsupported SSH key type "ssh-dss"/);
    expect(ssh.subject.short!(fingerprint)).toMatch(/^SHA256:.{8}….{4}$/);
    expect(sshGithub.subject.normalize(" @Octo-Cat ")).toBe("octo-cat");
    expect(() => sshGithub.subject.normalize("octo cat")).toThrow(/GitHub username/);
    expect(sshGitlab.subject.normalize("Some.One")).toBe("some.one");
  });

  it("verifies ECDSA and RSA keys too, and the file route with its trailing newline", async () => {
    for (const key of [other, rsa]) {
      const subject = parseSshPublicKey(key.publicKey).fingerprint, s = statementFor(ssh, subject);
      expect((await verify(ssh, s, await proveWith(ssh, key)(s))).source).toMatch(/^SSH signature \((nistp256|RSA 2048)\)$/);
    }
    const s = statementFor(ssh, fingerprint);
    expect((await verify(ssh, s, await signer(ssh).parse(mine.signFile(s.text), s))).subject).toBe(fingerprint);
  }, 20_000);

  it("refuses another namespace, another statement and another key, with a message a person can act on", async () => {
    const s = statementFor(ssh, fingerprint), paste = (text: string) => signer(ssh).parse(text, s);
    await expect(Promise.resolve().then(() => paste(mine.sign(s.text, "git")))).rejects.toThrow(/for "git", not "ghostly"/);
    await expect(Promise.resolve().then(() => paste(other.sign(s.text)))).rejects.toThrow(/made by SHA256:.*not the key you entered/);
    await expect(Promise.resolve().then(() => paste("ssh-ed25519 AAAA"))).rejects.toThrow(/whole signature/);
    const elsewhere = statementFor(ssh, fingerprint);
    await expect(verify(ssh, s, await paste(mine.sign(elsewhere.text)))).rejects.toThrow(/not over this statement/);
    await expect(verify(ssh, s, { signature: mine.sign(s.text, "file") })).rejects.toThrow(/namespace "file"/);
    await expect(verify(ssh, s, { signature: other.sign(s.text) })).rejects.toThrow(/another SSH key/);
    // A pasted signature re-wrapped by a chat app or Windows still verifies.
    const messy = mine.sign(s.text).replace(/\n/g, "\r\n  ");
    expect(await verify(ssh, s, await paste(messy))).toMatchObject({ subject: fingerprint });
  });

  it("links a GitHub account only while it publishes the signing key, asking api.github.com alone", async () => {
    const net = forges({ "github:octo-cat": [mine.publicKey] });
    const s = statementFor(sshGithub, "octo-cat"), evidence = await proveWith(sshGithub)(s);
    expect(await verify(sshGithub, s, evidence, net.fetch)).toEqual({ subject: "octo-cat", source: "GitHub: octo-cat (via published SSH key)" });
    expect(net.calls).toEqual(["https://api.github.com/users/octo-cat/keys?per_page=100"]);
    net.published["github:octo-cat"] = [other.publicKey];
    await expect(verify(sshGithub, s, evidence, net.fetch)).rejects.toThrow(/does not list the key that signed \(SHA256:/);
    delete net.published["github:octo-cat"];
    await expect(verify(sshGithub, s, evidence, net.fetch)).rejects.toThrow(/no account octo-cat/);
    const limited: IdentityFetch = async () => ({ status: 403, contentType: "application/json", text: "{}", bytes: new Uint8Array() });
    await expect(verify(sshGithub, s, evidence, limited)).rejects.toThrow(/api.github.com is limiting lookups/);
    // Asking for a size cap: the engine's fetch enforces it.
    let asked: unknown;
    await verify(sshGithub, s, evidence, async (url, options) => { asked = options; return forges({ "github:octo-cat": [mine.publicKey] }).fetch(url, options); });
    expect(asked).toMatchObject({ maxBytes: 256 * 1024 });
  });

  it("links a GitLab account through its user id", async () => {
    const net = forges({ "gitlab:some.one": [mine.publicKey] });
    const s = statementFor(sshGitlab, "some.one");
    expect((await verify(sshGitlab, s, await proveWith(sshGitlab)(s), net.fetch)).source).toBe("GitLab: some.one (via published SSH key)");
    expect(net.calls).toEqual(["https://gitlab.com/api/v4/users?username=some.one", "https://gitlab.com/api/v4/users/4242/keys?per_page=100"]);
  });
});
