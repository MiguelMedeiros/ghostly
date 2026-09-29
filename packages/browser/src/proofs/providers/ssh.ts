import {
  parseSshPublicKey, parseSshSignature, sshSignCommand, SshSigError, SSHSIG_MAX_ARMOR, SSHSIG_NAMESPACE, utf8Encode, verifySshSignature,
  type IdentityStatement, type SshSignatureCheck,
} from "@ghostly/core";
import type { ExternalToolSigner, IdentityProofProvider, VerifyContext } from "../contract";
import { checkSshForge, SSH_FORGE_HOST, SSH_FORGE_LABEL, validForgeLogin, type SshForge } from "../sshForges";

/**
 * SSH keys (draft WISP 3xx-ssh). The person signs the binding statement once with their own
 * `ssh-keygen -Y sign -n ghostly` and pastes the armored SSHSIG; the private key never enters Ghostly.
 *
 *  - `ssh`         the subject is the key's SHA-256 fingerprint; checked on this device, no network.
 *  - `ssh-github`  the subject is a GitHub account: the signing key must be one of the SSH keys GitHub
 *  - `ssh-gitlab`  publishes for it (GitLab alike). No OAuth: only the account holder can add a key, so
 *                  "this account lists the key" links the two. Re-checked, since keys get removed.
 */

export interface SshEvidence { signature: string }

const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;

function normalizeKeySubject(input: string): string {
  const value = input.trim();
  if (FINGERPRINT.test(value)) return value;
  try { return parseSshPublicKey(value).fingerprint; }
  catch (e) {
    // Say why a real key is refused (a DSA key, a small RSA key); anything else gets the instruction.
    if (e instanceof SshSigError && /^(Unsupported SSH key type|RSA keys must)/.test(e.message)) throw Object.assign(new Error(e.message), { cause: e });
    throw Object.assign(new Error("Paste your public key (the one line in ~/.ssh/id_ed25519.pub) or its SHA256: fingerprint"), { cause: e });
  }
}

function normalizeLogin(forge: SshForge, input: string): string {
  const login = input.trim().replace(/^@/, "").toLowerCase();
  if (!validForgeLogin(forge, login)) throw new Error(`Enter a ${SSH_FORGE_LABEL[forge]} username`);
  return login;
}

/** The armor, re-wrapped canonically, so evidence is the same whatever the clipboard did to it. */
function canonicalArmor(pasted: string): string {
  const parsed = parseSshSignature(pasted);
  if (parsed.namespace !== SSHSIG_NAMESPACE) throw new Error(`That signature is for "${parsed.namespace}", not "${SSHSIG_NAMESPACE}": run the command with -n ${SSHSIG_NAMESPACE}`);
  const body = pasted.replace(/\r\n/g, "\n").trim().split("\n").map(l => l.trim()).slice(1, -1).join("");
  return `-----BEGIN SSH SIGNATURE-----\n${body.match(/.{1,70}/g)!.join("\n")}\n-----END SSH SIGNATURE-----\n`;
}

/** Exactly the statement; or with one trailing newline, which an editor adds when the statement is
 * saved to a file and signed there (the Windows route). Nothing else is accepted. */
async function verifyStatementSignature(statement: IdentityStatement, evidence: SshEvidence): Promise<SshSignatureCheck> {
  try { return await verifySshSignature(evidence.signature, statement.bytes); }
  catch (e) {
    if (!(e instanceof SshSigError) || !/does not match this statement/.test(e.message)) throw e;
    try { return await verifySshSignature(evidence.signature, utf8Encode(`${statement.text}\n`)); }
    catch (again) { throw Object.assign(new Error("The signature is not over this statement: copy the command again and sign exactly what it shows"), { cause: again }); }
  }
}

const keyKind = (c: SshSignatureCheck) => c.securityKey
  ? `security key, touch${c.securityKey.userVerified ? " and PIN" : ""} confirmed`
  : c.key.type === "ssh-rsa" ? `RSA ${c.key.bits}` : c.key.type.replace(/^ssh-|^ecdsa-sha2-/, "");

function sshKeygenSigner(forAccount?: SshForge): ExternalToolSigner<SshEvidence> {
  return {
    id: "ssh-keygen", kind: "external-tool", label: "ssh-keygen",
    description: forAccount
      ? `Sign with an SSH key that your ${SSH_FORGE_LABEL[forAccount]} account lists (Settings → SSH keys).`
      : "Sign with OpenSSH's ssh-keygen (8.1 or later): a key file, ssh-agent, or a FIDO security key.",
    instructions: statement => {
      let command: string | undefined;
      try { command = sshSignCommand(statement.text); } catch { command = undefined; }
      return {
        steps: [
          ...(command ? [{ text: "Run this in a terminal (macOS, Linux, or Git Bash/WSL on Windows). If your key is not ~/.ssh/id_ed25519, change the path after -f; a .pub path works when the private key is in ssh-agent or on a security key.", copy: command }] : []),
          { text: `${command ? "Or save" : "Save"} this statement to a file, run ssh-keygen -Y sign -n ${SSHSIG_NAMESPACE} -f <your key> <file>, and paste the <file>.sig it writes.`, copy: statement.text },
          { text: "Paste the whole signature it prints, from -----BEGIN SSH SIGNATURE----- to -----END SSH SIGNATURE-----. Your private key never leaves your computer." },
        ],
        paste: { label: "SSH signature", placeholder: "-----BEGIN SSH SIGNATURE-----", multiline: true },
      };
    },
    parse(pasted, statement) {
      const signature = canonicalArmor(pasted);
      if (!forAccount) {
        const { key } = parseSshSignature(signature);
        if (key.fingerprint !== statement.binding.subject) throw new Error(`That signature was made by ${key.fingerprint}, not the key you entered (${statement.binding.subject})`);
      }
      return { signature };
    },
  };
}

function parseSshEvidence(raw: unknown): SshEvidence {
  const e = raw as SshEvidence;
  if (!e || typeof e !== "object" || Array.isArray(e) || Object.keys(e).join(",") !== "signature" ||
    typeof e.signature !== "string" || e.signature.length > SSHSIG_MAX_ARMOR) throw new Error("That is not an SSH signature");
  return { signature: e.signature };
}

const shortFingerprint = (f: string) => `${f.slice(0, 15)}…${f.slice(-4)}`;

export const ssh: IdentityProofProvider<SshEvidence> = {
  id: "ssh",
  label: "SSH key",
  category: "self-custodied",
  summary: "Sign once with ssh-keygen",
  description: "Proves you hold an SSH key, including FIDO security keys: sign the statement once with ssh-keygen and paste the signature.",
  platforms: ["web", "extension", "desktop"],
  subject: {
    label: "Public key", placeholder: "ssh-ed25519 AAAA… (or SHA256:…)",
    help: "Your public key, the one line in the .pub file. Contacts see its fingerprint.",
    normalize: normalizeKeySubject, short: shortFingerprint,
  },
  validity: { defaultDays: 90, maxDays: 365 },
  privacy: "Nothing: the signature is checked on this device. The key's fingerprint links every chat you share it in.",
  signers: [sshKeygenSigner()],
  parseEvidence: parseSshEvidence,
  async verify(statement, evidence) {
    const check = await verifyStatementSignature(statement, evidence);
    if (check.key.fingerprint !== statement.binding.subject) throw new Error("Signed by another SSH key");
    return { subject: statement.binding.subject, source: `SSH signature (${keyKind(check)})` };
  },
};

function forgeProvider(forge: SshForge): IdentityProofProvider<SshEvidence> {
  const label = SSH_FORGE_LABEL[forge], host = SSH_FORGE_HOST[forge];
  return {
    id: `ssh-${forge}`,
    label: `${label} (SSH key)`,
    category: "self-custodied",
    summary: `A key your ${label} account lists`,
    description: `Proves you hold an SSH key your ${label} account publishes: sign the statement once with ssh-keygen. No ${label} login.`,
    limits: `Does not prove a ${label} login: only that a key the account lists is yours, for as long as it stays listed.`,
    platforms: ["web", "extension", "desktop"],
    subject: { label: `${label} username`, placeholder: forge === "github" ? "octocat" : "username", normalize: input => normalizeLogin(forge, input) },
    publicUri: login => `https://${forge === "github" ? "github.com" : "gitlab.com"}/${login}`,
    validity: { defaultDays: 90, maxDays: 365 },
    // Keys get removed from accounts; the contact's app offers "Check again" after this.
    recheck: { afterSeconds: 600 },
    privacy: `Your contact's app asks ${host} for this account's public SSH keys, when you share it and on each re-check: ${label} learns the account was looked up, and from which IP address. So does this app when you add it.`,
    signers: [sshKeygenSigner(forge)],
    parseEvidence: parseSshEvidence,
    async verify(statement, evidence, ctx: VerifyContext) {
      const login = statement.binding.subject;
      if (normalizeLogin(forge, login) !== login) throw new Error(`Not a ${label} username`);
      const check = await verifyStatementSignature(statement, evidence);
      const status = await checkSshForge(forge, login, check.key, ctx.fetch, ctx.signal);
      if (status === "no-account") throw new Error(`${label} has no account ${login}`);
      if (status === "not-listed") throw new Error(`${label}: ${login} does not list the key that signed (${check.key.fingerprint})`);
      return { subject: login, source: `${label}: ${login} (via published SSH key)` };
    },
  };
}

export const sshGithub = forgeProvider("github");
export const sshGitlab = forgeProvider("gitlab");
