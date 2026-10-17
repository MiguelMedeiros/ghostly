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
 * A join given no invite reads stdin, but a pipe nobody writes or closes (what Node's exec and most harnesses give a
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
    if (params.token !== undefined) return warning("A token");
    const missing = () => new CliError("usage", "Missing <cashu-token>: give it as an argument or on stdin (… | ghostly wallet redeem)");
    if (tty) throw missing();
    const token = (await read()).trim();
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
    const value = (params[join.param] === "-" ? await read() : await readUnasked(read, note, join)).trim();
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

async function readUnasked(read: StdinRead, note: (text: string) => void, join: { arg: string; command: string; what: string }): Promise<string> {
  let noteTimer: ReturnType<typeof setTimeout> | undefined, giveUpTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => { clearTimeout(noteTimer); clearTimeout(giveUpTimer); };
  const nothingCame = new Promise<never>((_, reject) => {
    noteTimer = setTimeout(() => note(`Waiting for ${join.what.toLowerCase()} on stdin (… | ghostly ${join.command}): give it there or as an argument`), STDIN_NOTE_MS);
    giveUpTimer = setTimeout(() => reject(new CliError("usage", `Missing ${join.arg}: nothing came on stdin in ${STDIN_GIVE_UP_MS / 1000} s; give it there (… | ghostly ${join.command}) or as an argument`)), STDIN_GIVE_UP_MS);
  });
  try { return await Promise.race([read(stop), nothingCame]); }
  finally { stop(); }
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
