/**
 * The app's secret guard (apps/ui/src/lib/parse/secrets.ts), with BIP39's lists in the app's other languages loaded
 * from the start: the web app loads them as its composer opens.
 */
import "../../../apps/ui/src/lib/parse/seedLists";
import { findSecret, type SecretFinding } from "../../../apps/ui/src/lib/parse/secrets";
import { CliError } from "./errors";

export { findSecret };

/** What a refusal says the text looks like. */
export function secretWords(secret: SecretFinding): string {
  if (secret.kind === "cashu") return "a Cashu token (money anyone who reads it can take)";
  return secret.kind === "node-login" ? "a secret (a login to a node: a macaroon, a rune, an RPC password or cookie)" : "a secret (a seed or a private key)";
}

/**
 * The guard `send` has (docs/CLI.md § Safety), for any other text a command sends off the device (a group's name, the
 * name contacts see, a file's name, a revocation's reason): one that looks like a seed, a private key, a login to a node
 * or a Cashu token goes only with `--force`. `what` names the text ("group's name"), `verb` what `--force` does ("rename it").
 */
export function guardText(text: unknown, force: boolean, what: string, verb: string): void {
  if (force || typeof text !== "string" || !text) return;
  const secret = findSecret(text);
  if (secret) throw new CliError("confirm", `The ${what} looks like ${secretWords(secret)}; ${verb} with --force if you mean to`, { kind: secret.kind });
}
