import { initApp, publishApp, revokeApp, signStore, verifyApp } from "../apps";
import { CliError } from "../errors";
import { here, type Command } from "./shared";

/** The key file a command signs with: always named, never a default, never on the command line itself. */
function keyFile(value: unknown, usage: string): string {
  if (typeof value !== "string" || !value) throw new CliError("usage", `--key <file> is needed: ghostly ${usage}`);
  return value;
}

const key = { type: "string", description: "The key file (made, owner-only, when it is missing)" } as const;

/**
 * The publisher tools of WISP 1200 (Apps · Publishing): they run here, on files, with no profile or daemon. And the
 * apps a profile serves as a bot (`app serve`, `app served`, `app unserve`), which are the profile's. One entry per
 * command, in alphabetical order (test/commands.test.ts checks).
 */
export const commands: Record<string, Command> = {
  "app close": {
    method: "app.close", usage: "app close <chat> <ref|name>",
    summary: "Close a served app in a chat: the contact's app hears it ended",
    args: ["chat", "ref"],
    params: (_, a) => ({ chat: a.chat, ref: a.ref }),
  },
  "app init": {
    method: "app.init", usage: "app init <dir> [--name <name>] [--title <title>] [--force]",
    summary: "Start an app (WISP 1200): a small working one in <dir>, its ghostly-app.json, an index.html that says hello to the contact and a README, ready for app publish",
    args: ["dir"],
    options: {
      name: { type: "string", description: "The app's name, lowercase letters, digits and hyphens (default: the folder's)" },
      title: { type: "string", description: "The title people see, up to 40 characters (default: from the name)" },
      force: { type: "boolean", description: "Replace the three files when they are there" },
    },
    run: ({ options }, a) => initApp(a.dir!, { name: options.name as string | undefined, title: options.title as string | undefined, force: options.force === true }),
  },
  "app open": {
    method: "app.open", usage: "app open <chat> <ref|name> [--no-card]",
    summary: "Open a served app in a chat, as a bot (needs the daemon): the contact gets the app's card, unless their app is open there already, and the two sides can talk once both opened it",
    args: ["chat", "ref"],
    options: { "no-card": { type: "boolean", description: "Send no app card, only say the app is open" } },
    params: ({ options }, a) => ({ chat: a.chat, ref: a.ref, noCard: options["no-card"] === true }),
  },
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
  "app serve": {
    method: "app.serve", usage: "app serve <bundle|url> --grant chat [--grant name] [--url <url>]",
    summary: "Serve an app as a bot (WISP 1200): its signed .ghostlyapp is checked as a client would, and the profile speaks the app's messages in chats itself; each permission the app asks needs its --grant",
    args: ["bundle"],
    options: {
      grant: { type: "list", description: "A permission the app asks and you allow: chat (talk to the contact's app) or name (your name in that chat); again for each" },
      url: { type: "string", description: "Where a contact's app reads the bundle, for the card (default: the URL it was served from, else the manifest's first source)" },
    },
    params: ({ options }, a) => ({ bundle: /^[a-z][a-z0-9+.-]*:\/\//i.test(a.bundle ?? "") ? a.bundle : here(a.bundle), grant: options.grant, url: options.url }),
  },
  "app served": {
    method: "app.served", usage: "app served",
    summary: "The apps this profile serves as a bot, and whether apps/1 is offered to contacts now",
  },
  "app unserve": {
    method: "app.unserve", usage: "app unserve <ref|name>",
    summary: "Stop serving an app, by its reference or its name",
    args: ["ref"],
    params: (_, a) => ({ ref: a.ref }),
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
