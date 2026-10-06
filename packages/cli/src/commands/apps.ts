import { publishApp, revokeApp, signStore, verifyApp } from "../apps";
import { CliError } from "../errors";
import type { Command } from "./shared";

/** The key file a command signs with: always named, never a default, never on the command line itself. */
function keyFile(value: unknown, usage: string): string {
  if (typeof value !== "string" || !value) throw new CliError("usage", `--key <file> is needed: ghostly ${usage}`);
  return value;
}

const key = { type: "string", description: "The key file (made, owner-only, when it is missing)" } as const;

/**
 * The publisher tools of WISP 1200 (Apps · Publishing): they run here, on files, with no profile or daemon. One entry
 * per command, in alphabetical order (test/commands.test.ts checks).
 */
export const commands: Record<string, Command> = {
  "app publish": {
    method: "app.publish", usage: "app publish <dir> --key <file> [--out <file>]",
    summary: "Bundle and sign an app (WISP 1200): <dir>/ghostly-app.json and every other file in <dir> become one .ghostlyapp, its sequence one more than the bundle at --out (default <dir>/app.ghostlyapp)",
    args: ["dir"],
    options: {
      key: { ...key, description: "The publisher key file (made, owner-only, on first use; back it up)" },
      out: { type: "string", description: "Where the bundle goes (default <dir>/app.ghostlyapp); the bundle there is the version this one follows" },
      sequence: { type: "number", description: "This version's sequence, higher than the bundle at --out's (default: one more than it)" },
    },
    run: ({ options }, a) => publishApp(a.dir!, keyFile(options.key, "app publish <dir> --key <file> [--out <file>] [--sequence n]"), options.out as string | undefined, options.sequence as number | undefined),
  },
  "app revoke": {
    method: "app.revoke", usage: "app revoke <dir> --key <file> (--digest <digest>... | --up-to <sequence>) [--reason <text>] [--bundle <file>]",
    summary: "Revoke versions of your app (WISP 1200 · Revocation): a ghostly-revoke/1 statement signed with its publisher key, added to <dir>/ghostly-revoke.json",
    args: ["dir"],
    options: {
      key: { type: "string", description: "The app's publisher key file (never made here)" },
      digest: { type: "list", description: "A version's digest, base64url as app verify prints it (again for each, up to 64)" },
      "up-to": { type: "number", description: "Every version with this sequence or a lower one" },
      reason: { type: "string", description: "Why, one line of up to 200 characters, shown to people" },
      bundle: { type: "string", description: "The bundle naming the app (default <dir>/app.ghostlyapp)" },
    },
    run: ({ options }, a) => revokeApp(a.dir!, keyFile(options.key, "app revoke <dir> --key <file> (--digest <digest>... | --up-to <sequence>) [--reason <text>]"), {
      digests: options.digest as string[] | undefined, upTo: options["up-to"] as number | undefined,
      reason: options.reason as string | undefined, bundle: options.bundle as string | undefined,
    }),
  },
  "app verify": {
    method: "app.verify", usage: "app verify <bundle|url>",
    summary: "Check a .ghostlyapp as a client would, from a file or an https URL: its manifest and digest, or refused (exit 1) with the reason",
    args: ["bundle"],
    run: (_, a) => verifyApp(a.bundle!),
  },
  "store sign": {
    method: "store.sign", usage: "store sign <index> --key <file> [--out <dir>]",
    summary: "Sign a store index (WISP 1200 · Stores): writes ghostly-store.json, canonical, and ghostly-store.sig beside it or in --out",
    args: ["index"],
    options: {
      key: { ...key, description: "The store key file (made, owner-only, when it is missing and the index names no key; keep it offline)" },
      out: { type: "string", description: "The folder to write ghostly-store.json and ghostly-store.sig in (default: the index's)" },
    },
    run: ({ options }, a) => signStore(a.index!, keyFile(options.key, "store sign <index> --key <file> [--out <dir>]"), options.out as string | undefined),
  },
};
