import { CliError } from "./errors";

/**
 * Secrets a command takes (a Cashu token, an API key, a card's form) come on stdin: on the command line they show in
 * `ps` to every user of the machine while the command runs, and stay in the shell's history. Still taken there, with
 * a warning. Fills `params` in place; the warning to print on stderr, if any. `tty`: stdin is a terminal, where a
 * read would wait on the keyboard without a word.
 */
const JOINS: Record<string, { param: string; arg: string; command: string; what: string }> = {
  "group.join": { param: "link", arg: "<link>", command: "group join", what: "A group's link" },
  "invite.join": { param: "invite", arg: "<invite-or-link>", command: "invite join", what: "An invite" },
};

/**
 * A join given no invite, a redeem given no token and a send given no text read stdin, but a pipe nobody writes or closes (what Node's exec and most harnesses give a
 * child) would hold it for ever without a word: a note once nothing has come for a while, the usage error once nothing
 * has come at all. A producer that started writing is waited for to the end; `-` asked for stdin and waits as long.
 */
export const STDIN_NOTE_MS = 2_000;
export const STDIN_GIVE_UP_MS = 60_000;

/** `read`'s `onData`: called at the first chunk, once something is coming. */
export type StdinRead = (onData?: () => void) => Promise<string>;

export async function secretsFromStdin(method: string, params: Record<string, unknown>, read: StdinRead, tty = false, note: (text: string) => void = () => {}): Promise<string | undefined> {
  const warning = (what: string) => `${what} on the command line shows in ps and the shell's history: give it on stdin instead`;
  if (method === "wallet.redeem") {
    if (params.token !== undefined && params.token !== "-") return warning("A token");
    const missing = () => new CliError("usage", "Missing <cashu-token>: give it as an argument or on stdin (… | ghostly wallet redeem)");
    if (tty) throw missing();
    const token = (params.token === "-" ? await read() : await readUnasked(read, note, { what: "a Cashu token", missing: "Missing <cashu-token>", command: "wallet redeem", as: "an argument" })).trim();
    if (!token) throw missing();
    params.token = token;
    return undefined;
  }
  // A group's link and a chat's invite are secrets everywhere else (hidden in `group show`, in no event): the same here.
  const join = JOINS[method];
  if (join) {
    if (params[join.param] !== undefined && params[join.param] !== "-") return warning(join.what);
    const missing = () => new CliError("usage", `Missing ${join.arg}: give it on stdin (… | ghostly ${join.command}) or as an argument`);
    if (tty) throw missing();
    const value = (params[join.param] === "-" ? await read() : await readUnasked(read, note, { what: join.what.toLowerCase(), missing: `Missing ${join.arg}`, command: join.command, as: "an argument" })).trim();
    if (!value) throw missing();
    params[join.param] = value;
    return undefined;
  }
  if (method === "wallet.create") {
    // A form's fields are often plain (a network, a script type): the API key here, the secret fields by
    // `secretValuesWarning` once the source's form is known.
    const onLine = params.apiKey !== undefined;
    if (params.stdin === true) {
      const values = { ...(params.values as Record<string, string> | undefined) };
      for (const line of (await read()).split(/\r?\n/)) {
        if (!line.trim()) continue;
        const eq = line.indexOf("=");
        if (eq < 1) throw new CliError("usage", "--stdin takes name=value lines (api-key=… for the API key)");
        const name = line.slice(0, eq).trim(), value = line.slice(eq + 1);
        if (name === "api-key") params.apiKey = value;
        else values[name] = value;
      }
      if (Object.keys(values).length) params.values = values;
    }
    delete params.stdin;
    return onLine ? warning("An API key") : undefined;
  }
  return undefined;
}

/**
 * `send`, `edit`, `group send` and `group edit` with no text words read it from stdin the same way: `command` is the
 * command line as given (`send bob`). `asked`: `--stdin`, which waits as long as it takes.
 */
export async function textFromStdin(read: StdinRead, command: string, asked: boolean, note: (text: string) => void): Promise<string> {
  const text = asked ? await read() : await readUnasked(read, note, { what: "the text", missing: "No text", command, as: "arguments" });
  return text.replace(/\n$/, "");
}

/**
 * `identity complete <draft>` with neither --evidence-file nor --stdin, stdin not a terminal: asked with nothing first,
 * since a published record takes none; a draft that answers it takes a tool's output (`details.needs`) is asked again
 * with what was piped, read as a send reads its text.
 */
export async function completeWithPipedEvidence(call: (params: Record<string, unknown>) => Promise<unknown>, params: Record<string, unknown>, read: StdinRead, note: (text: string) => void): Promise<unknown> {
  try { return await call(params); } catch (error) {
    if (!(error instanceof CliError) || error.details?.needs !== "evidence") throw error;
  }
  const evidence = await readUnasked(read, note, { what: "what the tool printed", missing: "Missing what the tool printed", command: `identity complete ${String(params.draft)}`, as: "--evidence-file f" });
  return call({ ...params, evidence });
}

/** What `readUnasked` says: `what` is waited for, `missing` is the usage error's title, `as` the other way to give it. */
interface Unasked { what: string; missing: string; command: string; as: string }

async function readUnasked(read: StdinRead, note: (text: string) => void, ask: Unasked): Promise<string> {
  let noteTimer: ReturnType<typeof setTimeout> | undefined, giveUpTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => { clearTimeout(noteTimer); clearTimeout(giveUpTimer); };
  const nothingCame = new Promise<never>((_, reject) => {
    noteTimer = setTimeout(() => note(`Waiting for ${ask.what} on stdin (… | ghostly ${ask.command}): give it there or as ${ask.as}`), STDIN_NOTE_MS);
    giveUpTimer = setTimeout(() => reject(new CliError("usage", `${ask.missing}: nothing came on stdin in ${STDIN_GIVE_UP_MS / 1000} s; give it there (… | ghostly ${ask.command}) or as ${ask.as}`)), STDIN_GIVE_UP_MS);
  });
  try { return await Promise.race([read(stop), nothingCame]); }
  finally { stop(); }
}

/**
 * `identity add`'s fields: each `--field name=value`, then with `--stdin` the `name=value` lines piped to it (a NIP-46
 * signer's bunker:// link holds the signer's secret). `secret`: the names the signer's form marks `kind: "secret"`
 * (`identitySecretFields`); one given as a `--field` still goes, with the warning. Neither error repeats a value.
 */
export async function identityFields(items: string[], stdin: boolean, secret: string[], read: StdinRead, tty = false): Promise<{ fields: Record<string, string>; warning?: string }> {
  const fields: Record<string, string> = {};
  for (const item of items) {
    const eq = item.indexOf("=");
    if (eq < 1) throw new CliError("usage", "--field takes name=value, and one has no name or no =");
    fields[item.slice(0, eq)] = item.slice(eq + 1);
  }
  const onLine = secret.filter((name) => fields[name] !== undefined);
  if (stdin) {
    if (tty) throw new CliError("usage", "--stdin takes the fields as name=value lines piped to it (… | ghostly identity add <provider> --signer id --stdin), not a terminal");
    for (const line of (await read()).split(/\r?\n/)) {
      if (!line.trim()) continue;
      const eq = line.indexOf("=");
      if (eq < 1) throw new CliError("usage", "--stdin takes name=value lines, and one has no name or no =");
      fields[line.slice(0, eq).trim()] = line.slice(eq + 1);
    }
  }
  if (!onLine.length) return { fields };
  return { fields, warning: `${onLine.map((name) => `--field ${name}`).join(", ")} on the command line shows in ps and the shell's history: give ${onLine.length > 1 ? "them" : "it"} on stdin instead (--stdin, name=value lines)` };
}

/** The fields a provider's signer marks `kind: "secret"`: the one `--signer` names, or any of its signers when none is. */
export function identitySecretFields(provider: { signers: readonly { id: string; fields?: readonly { name: string; kind?: string }[] }[] } | undefined, signer?: string): string[] {
  const signers = (provider?.signers ?? []).filter((s) => signer === undefined || s.id === signer);
  return [...new Set(signers.flatMap((s) => (s.fields ?? []).filter((f) => f.kind === "secret").map((f) => f.name)))];
}

/**
 * `wallet create --value`: the names given on the command line that the chosen source's form marks `kind: "secret"`
 * (an NWC URI, a macaroon, a rune, an RPC password), as a warning. `list`: a `wallet.list` answer, where the forms are.
 */
export function secretValuesWarning(list: unknown, type: unknown, provider: unknown, names: string[]): string | undefined {
  if (!names.length) return undefined;
  const id = provider ?? (type === "bitcoin" ? "bdk" : undefined);
  const offers = (list as { offers?: { type?: string; providers?: { id: string; fields?: { name: string; kind?: string }[] }[] }[] } | undefined)?.offers ?? [];
  const fields = offers.find((o) => o.type === type && o.providers)?.providers?.find((p) => p.id === id)?.fields ?? [];
  const secret = names.filter((name) => fields.some((f) => f.name === name && f.kind === "secret"));
  if (!secret.length) return undefined;
  return `${secret.map((name) => `--value ${name}`).join(", ")} on the command line shows in ps and the shell's history: give ${secret.length > 1 ? "them" : "it"} on stdin instead (--stdin, name=value lines)`;
}
