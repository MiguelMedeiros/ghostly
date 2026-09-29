import type { LightningProviderDescriptor } from "../engine/paymentAdapters/providers/lightning";
import type { OnchainProviderDescriptor } from "../engine/paymentAdapters/providers/onchain";
import { providerDescriptorProblems, type ProviderDescriptor, type ProviderKind } from "../engine/paymentAdapters/providers/types";
import type { IdentityProofProvider } from "../proofs/contract";
import { descriptorProblems } from "../proofs/verify";
import { BUNDLED_PLUGINS } from "./bundled";

/**
 * Adapters written outside the app: wallet sources (Lightning, on-chain) and identity-proof providers
 * that register here instead of being added to the built-in lists. A plugin is a plain object naming
 * its adapters; the registries (`providers/registry.ts`, `proofs/registry.ts`) list what is registered
 * after the built-ins and before the test fakes, and the same platform and mode rules apply to all.
 *
 * Two ways in:
 *  - at build time: `GHOSTLY_PLUGINS` lists the modules and `bundled.ts` is swapped for them;
 *  - at run time: code already running in the engine's realm calls `registerAdapters` before the
 *    pickers are shown (or after: the engine re-reads the lists when something registers).
 *
 * Trust: a plugin runs with the app's privileges, in the app's own JavaScript realm. There is no
 * sandbox, no permission prompt and no store; whoever builds a plugin in, or loads one, trusts its
 * author with everything the app can do, keys and sats included. A manifest with permissions and an
 * isolated runtime are a later phase (docs/wisps/ADAPTER-ROADMAP.md, "Plugins, apps, catalogs").
 *
 * The state lives on `globalThis` under a well-known symbol, so a plugin bundled with its own copy of
 * the SDK (a second copy of this module) still registers into the same lists the app reads.
 */

/** The generation of the adapter contracts. A plugin says which one it was written against. */
export const SDK_API = 1;
export const PLUGIN_ID = /^[a-z][a-z0-9-]{0,63}$/;

export interface GhostlyAdapterPlugin {
  /** Stable, unique among plugins: `^[a-z][a-z0-9-]{0,63}$`. */
  id: string;
  /** The plugin's own version, for people. */
  version?: string;
  /** The contract generation it was written against: `SDK_API`. Another one is refused. */
  sdk: number;
  lightning?: readonly LightningProviderDescriptor[];
  onchain?: readonly OnchainProviderDescriptor[];
  identities?: readonly IdentityProofProvider[];
}

export type AdapterKind = ProviderKind | "identity";

interface Store {
  plugins: Map<string, GhostlyAdapterPlugin>;
  /** Ids the built-in registries own, per kind: a plugin cannot take one. */
  reserved: Record<AdapterKind, Set<string>>;
  listeners: Set<() => void>;
  seeded: boolean;
}

const KEY = Symbol.for("ghostly.adapters/1");
function store(): Store {
  const g = globalThis as unknown as Record<symbol, Store | undefined>;
  return (g[KEY] ??= { plugins: new Map(), reserved: { lightning: new Set(), onchain: new Set(), identity: new Set() }, listeners: new Set(), seeded: false });
}

const ids = (kind: AdapterKind, plugin: GhostlyAdapterPlugin): string[] => {
  // Not trusted to be well formed: pluginProblems reads it before saying what is wrong with it.
  const list: unknown = kind === "identity" ? plugin.identities : kind === "lightning" ? plugin.lightning : plugin.onchain;
  return Array.isArray(list) ? list.map((a: { id?: string } | null) => a?.id as string) : [];
};
const KINDS: readonly AdapterKind[] = ["lightning", "onchain", "identity"];

/** Problems with a plugin, empty when it can be registered. Does not look at what is already registered. */
export function pluginProblems(plugin: GhostlyAdapterPlugin): string[] {
  const problems: string[] = [];
  if (!plugin || typeof plugin !== "object") return ["not a plugin object"];
  if (!PLUGIN_ID.test(plugin.id ?? "")) problems.push("plugin id must match ^[a-z][a-z0-9-]{0,63}$");
  if (plugin.sdk !== SDK_API) problems.push(`plugin was written for SDK API ${String(plugin.sdk)}; this app speaks ${SDK_API}`);
  if (plugin.version !== undefined && (typeof plugin.version !== "string" || plugin.version.length > 64)) problems.push("version must be a short string");
  for (const kind of ["lightning", "onchain"] as const) {
    const list = plugin[kind];
    if (list === undefined) continue;
    if (!Array.isArray(list)) { problems.push(`${kind} must be a list of descriptors`); continue; }
    for (const d of list as ProviderDescriptor<unknown>[]) {
      if (!d || typeof d !== "object") { problems.push(`${kind} ${String(d)}: not a descriptor`); continue; }
      const own = providerDescriptorProblems(d);
      if (d?.kind && d.kind !== kind) own.push(`is listed under ${kind} but says kind ${String(d.kind)}`);
      problems.push(...own.map((p) => `${kind} ${String(d?.id)}: ${p}`));
    }
  }
  if (plugin.identities !== undefined) {
    if (!Array.isArray(plugin.identities)) problems.push("identities must be a list of providers");
    else for (const p of plugin.identities) {
      if (!p || typeof p !== "object") problems.push(`identity ${String(p)}: not a provider`);
      else problems.push(...descriptorProblems(p).map((m) => `identity ${String(p.id)}: ${m}`));
    }
  }
  for (const kind of KINDS) {
    const list = ids(kind, plugin);
    if (new Set(list).size !== list.length) problems.push(`${kind} ids are not unique within the plugin`);
  }
  if (!KINDS.some((kind) => ids(kind, plugin).length)) problems.push("the plugin brings no adapter");
  return problems;
}

/** The built-in registries say which ids are theirs. A plugin using one is refused. */
export function reserveAdapterIds(kind: AdapterKind, list: readonly string[]): void {
  const s = store();
  for (const id of list) s.reserved[kind].add(id);
}

/**
 * Registers a plugin's adapters. Throws, registering nothing, when the plugin is malformed, its id or
 * one of its adapters' ids is taken (by a built-in or by another plugin), or its contract generation
 * is another one. Returns the function that unregisters it.
 */
export function registerAdapters(plugin: GhostlyAdapterPlugin): () => void {
  const problems = pluginProblems(plugin);
  const s = store();
  if (!problems.length) {
    if (s.plugins.has(plugin.id)) problems.push(`a plugin with id ${plugin.id} is already registered`);
    for (const kind of KINDS) for (const id of ids(kind, plugin)) {
      if (s.reserved[kind].has(id)) problems.push(`${kind} ${id} is a built-in of this app`);
      for (const other of s.plugins.values()) if (ids(kind, other).includes(id)) problems.push(`${kind} ${id} is already registered by plugin ${other.id}`);
    }
  }
  if (problems.length) throw new Error(`Cannot register plugin ${String(plugin?.id)}: ${problems.join("; ")}`);
  s.plugins.set(plugin.id, plugin);
  notify(s);
  return () => { if (s.plugins.get(plugin.id) === plugin) { s.plugins.delete(plugin.id); notify(s); } };
}

function notify(s: Store) { for (const listener of s.listeners) { try { listener(); } catch { /* a listener's problem */ } } }

/** Called when a plugin registers or unregisters: the engine re-reads the lists. */
export function onAdaptersChanged(listener: () => void): () => void {
  const s = store();
  s.listeners.add(listener);
  return () => { s.listeners.delete(listener); };
}

/** Every registered plugin, in registration order (bundled ones first). */
export function registeredPlugins(): readonly GhostlyAdapterPlugin[] { seed(); return [...store().plugins.values()]; }
export function registeredLightningProviders(): readonly LightningProviderDescriptor[] { return registeredPlugins().flatMap((p) => p.lightning ?? []); }
export function registeredOnchainProviders(): readonly OnchainProviderDescriptor[] { return registeredPlugins().flatMap((p) => p.onchain ?? []); }
export function registeredIdentityProviders(): readonly IdentityProofProvider[] { return registeredPlugins().flatMap((p) => p.identities ?? []); }

/**
 * The plugins compiled into this build register once, when they are first asked for. A broken one is
 * reported and skipped rather than taking the app down with it; the e2e that expects it fails instead.
 */
function seed() {
  const s = store();
  if (s.seeded) return;
  s.seeded = true;
  for (const plugin of BUNDLED_PLUGINS) {
    try { registerAdapters(plugin); }
    catch (error) { console.error(`[ghostly] a bundled adapter plugin was not loaded: ${error instanceof Error ? error.message : String(error)}`); }
  }
}

/** Tests only: forget every registration, including the bundled ones. */
export function resetAdapterRegistry(): void {
  const s = store();
  s.plugins.clear(); s.seeded = false;
  for (const kind of KINDS) s.reserved[kind].clear();
  notify(s);
}
