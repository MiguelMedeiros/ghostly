import type { GhostlyNode } from "@ghostly/browser/engine/node";
import type { EngineState, GroupView, LinkView } from "@ghostly/browser/shared/types";
import { CliError } from "./errors";
import type { CallManager } from "./calls/manager";
import type { EventHub } from "./events";
import type { Runtime } from "./runtime/engine";

/**
 * The methods of the local control API (WISP 1100): the daemon answers them over its socket, and a one-shot
 * command calls them in its own process. Parameters come from JSON: every one is checked here.
 */
export interface ApiContext {
  runtime: Runtime;
  hub: EventHub;
  /** Voice calls (WISP 1100 § Calls). */
  calls: CallManager;
  /** How the host runs: a daemon stays; a one-shot leaves when its command is done. */
  mode: "daemon" | "one-shot";
  version: string;
  /** The daemon asks to stop (answered first). */
  stop?: () => void;
}

export type Params = Record<string, unknown>;
export type Method = (ctx: ApiContext, params: Params) => Promise<unknown>;

export const node = (ctx: ApiContext): GhostlyNode => ctx.runtime.server.node;
export const state = (ctx: ApiContext): EngineState => node(ctx).getState();

// ---------- parameters ----------

export function str(params: Params, name: string, required: true): string;
export function str(params: Params, name: string, required?: false): string | undefined;
export function str(params: Params, name: string, required = false): string | undefined {
  const value = params[name];
  if (value === undefined || value === null || value === "") {
    if (required) throw new CliError("bad_request", `${name} is required`);
    return undefined;
  }
  if (typeof value !== "string") throw new CliError("bad_request", `${name} must be a string`);
  return value;
}
export function num(params: Params, name: string, fallback: number, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}): number {
  const value = params[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new CliError("bad_request", `${name} must be a number from ${min} to ${max}`);
  return value;
}
export function bool(params: Params, name: string): boolean {
  const value = params[name];
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") throw new CliError("bad_request", `${name} must be true or false`);
  return value;
}
export function list(params: Params, name: string): string[] {
  const value = params[name];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new CliError("bad_request", `${name} must be a list of strings`);
  return value as string[];
}
export function oneOf<T extends string>(params: Params, name: string, values: readonly T[], fallback: T): T {
  const value = str(params, name) ?? fallback;
  if (!values.includes(value as T)) throw new CliError("bad_request", `${name} must be one of ${values.join(", ")}`);
  return value as T;
}

// ---------- finding things ----------

/** A contact key as chats show it (`peer`): 52 characters of z-base-32. */
export const CONTACT_KEY = /^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/;

/**
 * A chat by its id; by its contact's key (only by the key: a name is never taken for one); by a unique prefix of its
 * id; or by its name: the label this side gave it first, and only when no label matches, the name the contact gave
 * itself (which the contact controls, so it never wins over a label).
 */
export function findChat(links: readonly LinkView[], ref: string): LinkView {
  const exact = links.find((link) => link.id === ref);
  if (exact) return exact;
  if (CONTACT_KEY.test(ref)) {
    const byKey = links.filter((link) => link.peerPubKeyZ32 === ref);
    if (byKey.length === 1) return byKey[0];
    if (byKey.length > 1) throw new CliError("bad_request", `${JSON.stringify(ref)} names more than one chat: use its id`, { matches: byKey.map((link) => link.id) });
    throw new CliError("not_found", `No chat with ${JSON.stringify(ref)}`);
  }
  const byPrefix = links.filter((link) => link.id.startsWith(ref));
  if (byPrefix.length === 1) return byPrefix[0];
  const lower = ref.toLowerCase();
  const named = (name: string | null | undefined) => name?.trim().toLowerCase() === lower;
  const byLabel = links.filter((link) => named(link.label));
  const byName = byLabel.length ? byLabel : links.filter((link) => named(link.peerNick));
  if (byName.length === 1) return byName[0];
  if (byPrefix.length > 1 || byName.length > 1) throw new CliError("bad_request", `${JSON.stringify(ref)} names more than one chat: use its id`, { matches: [...byPrefix, ...byName].map((link) => link.id) });
  throw new CliError("not_found", `No chat ${JSON.stringify(ref)}`);
}

export function findGroup(groups: readonly GroupView[], ref: string): GroupView {
  const exact = groups.find((group) => group.id === ref);
  if (exact) return exact;
  const byPrefix = groups.filter((group) => group.id.startsWith(ref));
  if (byPrefix.length === 1) return byPrefix[0];
  const byName = groups.filter((group) => group.name.trim().toLowerCase() === ref.toLowerCase());
  if (byName.length === 1) return byName[0];
  if (byPrefix.length > 1 || byName.length > 1) throw new CliError("bad_request", `${JSON.stringify(ref)} names more than one group: use its id`, { matches: [...byPrefix, ...byName].map((group) => group.id) });
  throw new CliError("not_found", `No group ${JSON.stringify(ref)}`);
}

export const chatOf = (ctx: ApiContext, params: Params) => findChat(state(ctx).links, str(params, "chat", true));

/**
 * A chat or a group, as `forward` names them: `group:<id>` is a group; anything else a chat first (id, prefix or name),
 * then a group. `linkId` is what the engine calls it.
 */
export function chatOrGroup(ctx: ApiContext, ref: string): { id: string; linkId: string; group: boolean } {
  if (ref.startsWith("group:")) { const group = findGroup(state(ctx).groups, ref.slice("group:".length)); return { id: group.id, linkId: `group:${group.id}`, group: true }; }
  try {
    const link = findChat(state(ctx).links, ref);
    return { id: link.id, linkId: link.id, group: false };
  } catch (error) {
    if (!(error instanceof CliError) || error.code !== "not_found") throw error;
    const group = findGroup(state(ctx).groups, ref);
    return { id: group.id, linkId: `group:${group.id}`, group: true };
  }
}

export const groupOf = (ctx: ApiContext, params: Params) => findGroup(state(ctx).groups, str(params, "group", true));

// ---------- waiting ----------

/** Resolves with `check`'s first defined answer: now, or on a later state; `timeout` error after `ms`. */
export function waitForState<T>(ctx: ApiContext, check: (state: EngineState) => T | undefined, ms: number, what: string): Promise<T> {
  const now = check(state(ctx));
  if (now !== undefined) return Promise.resolve(now);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new CliError("timeout", `Timed out after ${Math.round(ms / 1000)} s waiting for ${what}`)); }, ms);
    const off = ctx.hub.onState((next) => {
      const value = check(next);
      if (value === undefined) return;
      clearTimeout(timer);
      off();
      resolve(value);
    });
  });
}

