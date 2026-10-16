import { bool, node, str, type Method } from "./apiKit";
import { CliError } from "./errors";

/**
 * x401 credentials (WISP 3xx): the holder keys and issued credentials a bot keeps to show a website who stands behind
 * it. Here only keeping them: `x401 fetch`, which presents one, comes later. Claim values are printed only with
 * `--show-secret`; the credential itself and the holder keys never leave the profile.
 */

/** The engine's refusals (a credential that does not read, expired, bound to another key) are the caller's to fix. */
async function engine<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) {
    throw new CliError("bad_request", error instanceof Error ? error.message : String(error));
  }
}

export const X401_METHODS: Record<string, Method> = {
  /** `dropped`: the oldest key still waiting, gone for this one (a profile keeps the 8 newest waiting). */
  async "x401.key.new"(ctx) {
    const { id, jwk, dropped } = await node(ctx).newX401HolderKey();
    return { key: id, jwk, ...(dropped ? { dropped } : {}) };
  },

  async "x401.credential.add"(ctx, params) {
    const label = str(params, "label");
    return { credential: await engine(() => node(ctx).addX401Credential({ credential: str(params, "credential", true), ...(label ? { label } : {}) })) };
  },

  async "x401.credential.list"(ctx, params) {
    return { credentials: await node(ctx).x401Credentials({ values: bool(params, "showSecret") }) };
  },

  async "x401.credential.remove"(ctx, params) {
    const id = str(params, "id", true);
    if (!(await node(ctx).removeX401Credential({ id }))) throw new CliError("not_found", `No x401 credential ${JSON.stringify(id)} (ghostly x401 credential list)`);
    return { removed: id };
  },
};
