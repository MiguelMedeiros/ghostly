import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_PERMISSIONS, appRef, isAppRef, isAppUrl, type AppPermission } from "@ghostly/core";
import { list, str, type ApiContext, type Method } from "./apiKit";
import { checkedBundle } from "./apps";
import { CliError } from "./errors";

/*
 * `app serve` (WISP 1200 § A bot on the other side): the apps this profile speaks for, in chats, as a bot. No app runs
 * here: a program of the bot's own speaks the app's messages. An app is served from its signed bundle, checked as a
 * client checks one, and each permission its manifest asks is answered on the command line, never by itself. The list
 * is kept in the profile folder (`apps.json`); the engine offers apps/1 to contacts only while it holds an app, which
 * it reads when it starts.
 */

/** The permissions a bot can be granted: `internet` is a page's, and no page runs here. */
const GRANTABLE: readonly AppPermission[] = ["chat", "name"];

export interface ServedApp {
  ref: string;
  title: string;
  version: string;
  sequence: number;
  digest: string;
  /** Where a contact's app fetches the bundle (the app card's `url`), when one is known. */
  url?: string;
  /** What the manifest asks, and what this profile granted of it. */
  permissions: AppPermission[];
  granted: AppPermission[];
  servedAt: number;
}

const servedFile = (dir: string) => join(dir, "apps.json");

/** The apps a profile serves, by its folder: none when the file is missing or not a list of them. */
export function servedApps(dir: string): ServedApp[] {
  try {
    const read = JSON.parse(readFileSync(servedFile(dir), "utf8")) as unknown;
    return Array.isArray(read) ? read.filter((app): app is ServedApp => !!app && typeof app === "object" && isAppRef((app as ServedApp).ref)) : [];
  } catch { return []; }
}

function writeServed(dir: string, apps: ServedApp[]): void {
  const file = servedFile(dir);
  writeFileSync(file + ".tmp", JSON.stringify(apps, null, 2) + "\n", { mode: 0o600 });
  renameSync(file + ".tmp", file);
}

/** Whether this engine offers apps/1 now: it read the list when it started, so the first app served waits for a restart. */
const offered = (ctx: ApiContext, apps: ServedApp[]) => ({ offered: ctx.runtime.apps, ...(apps.length > 0 && !ctx.runtime.apps && { restart: true }) });

export const APP_SERVE_METHODS: Record<string, Method> = {
  async "app.serve"(ctx, params) {
    const source = str(params, "bundle", true);
    const grant = list(params, "grant");
    const unknown = grant.filter((p) => !(APP_PERMISSIONS as readonly string[]).includes(p));
    if (unknown.length) throw new CliError("bad_request", `grant takes ${GRANTABLE.join(" or ")}, not ${unknown.map((p) => JSON.stringify(p)).join(", ")}`);
    if (grant.includes("internet")) throw new CliError("refused", "internet cannot be granted here: no app's page runs on the CLI, and a bot reaches the network as its own program");
    const given = str(params, "url");
    if (given !== undefined && !isAppUrl(given)) throw new CliError("bad_request", "url is where a contact's app reads the bundle: https only, no user or password, jsDelivr only at a full commit");
    const { bundle, url } = await checkedBundle(source);
    const m = bundle.manifest;
    if (!m.permissions.includes("chat")) throw new CliError("refused", `${m.title} does not ask for chat: it talks to no contact, so a bot has nothing to speak for it`);
    const extra = grant.filter((p) => !m.permissions.includes(p as AppPermission));
    if (extra.length) throw new CliError("bad_request", `${m.title} does not ask for ${extra.join(" or ")}: grant only what its manifest asks (${m.permissions.join(", ")})`);
    const missing = m.permissions.filter((p) => GRANTABLE.includes(p) && !grant.includes(p));
    if (missing.length)
      throw new CliError("confirm", `${m.title} asks for ${missing.join(" and ")}: serve it with ${missing.map((p) => `--grant ${p}`).join(" ")} to allow that`, { asks: m.permissions, missing });
    const ref = appRef(m.publisher, m.name);
    const cardUrl = given ?? url ?? m.sources?.[0];
    const app: ServedApp = {
      ref, title: m.title, version: m.version, sequence: m.sequence, digest: bundle.digest, ...(cardUrl !== undefined && { url: cardUrl }),
      permissions: m.permissions, granted: m.permissions.filter((p) => grant.includes(p)), servedAt: Date.now(),
    };
    const apps = servedApps(ctx.runtime.paths.dir);
    const held = apps.find((a) => a.ref === ref);
    // Rollback, as a client's (WISP 1200 § Updates and rollback): never a lower sequence over a higher one, nor another
    // bundle under the same sequence.
    if (held && app.sequence < held.sequence) throw new CliError("refused", `${m.title} ${held.version} (sequence ${held.sequence}) is served: ${m.version} is older (sequence ${app.sequence}); app unserve it first to go back`);
    if (held && app.sequence === held.sequence && app.digest !== held.digest) throw new CliError("refused", `Another ${m.title} with sequence ${app.sequence} is served (two different versions ${app.sequence} exist); app unserve it first to take this one`);
    const next = [...apps.filter((a) => a.ref !== ref), app].sort((a, b) => (a.ref < b.ref ? -1 : 1));
    writeServed(ctx.runtime.paths.dir, next);
    return { served: app, ...offered(ctx, next) };
  },

  async "app.served"(ctx) {
    const apps = servedApps(ctx.runtime.paths.dir);
    return { apps, ...offered(ctx, apps) };
  },

  async "app.unserve"(ctx, params) {
    const ref = str(params, "ref", true);
    const apps = servedApps(ctx.runtime.paths.dir);
    const matches = apps.filter((a) => a.ref === ref || a.ref.split("/")[1] === ref);
    if (matches.length !== 1) throw new CliError(matches.length ? "bad_request" : "not_found", matches.length ? `${JSON.stringify(ref)} names more than one served app: give its whole reference` : `No served app ${JSON.stringify(ref)}`);
    const next = apps.filter((a) => a !== matches[0]);
    writeServed(ctx.runtime.paths.dir, next);
    return { unserved: matches[0].ref, apps: next.length, ...offered(ctx, next) };
  },
};
