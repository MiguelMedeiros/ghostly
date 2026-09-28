import { CliError } from "./errors";

/**
 * Secrets a command takes (a Cashu token, an API key, a card's form) come on stdin: on the command line they show in
 * `ps` to every user of the machine while the command runs, and stay in the shell's history. Still taken there, with
 * a warning. Fills `params` in place; the warning to print on stderr, if any.
 */
export async function secretsFromStdin(method: string, params: Record<string, unknown>, read: () => Promise<string>): Promise<string | undefined> {
  const warning = (what: string) => `${what} on the command line shows in ps and the shell's history: give it on stdin instead`;
  if (method === "wallet.redeem") {
    if (params.token !== undefined) return warning("A token");
    const token = (await read()).trim();
    if (!token) throw new CliError("usage", "Missing <cashu-token>: give it as an argument or on stdin");
    params.token = token;
    return undefined;
  }
  if (method === "wallet.create") {
    // A form's fields are often plain (a network, a script type): only the API key is warned about.
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
