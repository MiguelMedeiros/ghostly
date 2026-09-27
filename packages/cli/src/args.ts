import { CliError } from "./errors";

export type OptionType = "string" | "number" | "boolean" | "list";
export interface OptionSpec {
  type: OptionType; short?: string; description: string;
  /** A number option that may stand alone (then `true`): it takes the next word only when that is a number. */
  optionalValue?: boolean;
}
export interface Parsed { positionals: string[]; options: Record<string, string | number | boolean | string[] | undefined> }

/**
 * Options every command takes. They may come anywhere on the line.
 */
export const GLOBAL_OPTIONS: Record<string, OptionSpec> = {
  profile: { type: "string", short: "p", description: "Profile to use (default: $GHOSTLY_PROFILE, then the current one)" },
  home: { type: "string", description: "Ghostly's folder (default: $GHOSTLY_HOME, then ~/.ghostly)" },
  pretty: { type: "boolean", description: "Indent the JSON output" },
  help: { type: "boolean", short: "h", description: "Show help" },
};

/**
 * A small, strict parser: `--name value`, `--name=value`, `-x value`, boolean flags, repeatable lists, and `--`
 * before positionals that start with a dash.
 *
 * The value of an option is taken as is even when it starts with `-` (base64url keys and seeds do one time in 64:
 * the ghostly-cli lesson of #208). A positional that starts with `-` is refused instead of sent: a mistyped flag
 * must not reach a contact as text. Put `--` before a message that starts with a dash.
 */
export function parseArgs(argv: readonly string[], spec: Record<string, OptionSpec>): Parsed {
  const all = { ...GLOBAL_OPTIONS, ...spec };
  const byShort = new Map(Object.entries(all).filter(([, s]) => s.short).map(([name, s]) => [s.short!, name]));
  const positionals: string[] = [];
  const options: Parsed["options"] = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") { positionals.push(...argv.slice(i + 1)); break; }
    if (arg.startsWith("--") || (arg.startsWith("-") && arg.length === 2 && arg !== "-")) {
      let name: string, inline: string | undefined;
      if (arg.startsWith("--")) {
        const eq = arg.indexOf("=");
        name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
        inline = eq === -1 ? undefined : arg.slice(eq + 1);
      } else {
        const long = byShort.get(arg.slice(1));
        if (!long) throw new CliError("usage", `Unknown option ${arg}`);
        name = long;
      }
      if (name.startsWith("no-") && all[name.slice(3)]?.type === "boolean" && inline === undefined) { options[name.slice(3)] = false; continue; }
      const option = all[name];
      if (!option) throw new CliError("usage", `Unknown option --${name}`);
      if (option.type === "boolean") {
        if (inline !== undefined && !["true", "false"].includes(inline)) throw new CliError("usage", `--${name} takes no value`);
        options[name] = inline === undefined ? true : inline === "true";
        continue;
      }
      let value = inline;
      if (value === undefined && option.optionalValue && !(i + 1 < argv.length && argv[i + 1] !== "" && Number.isFinite(Number(argv[i + 1])))) {
        options[name] = true;
        continue;
      }
      if (value === undefined) {
        if (i + 1 >= argv.length) throw new CliError("usage", `--${name} needs a value`);
        value = argv[++i];
      }
      if (option.type === "number") {
        const number = Number(value);
        if (!Number.isFinite(number)) throw new CliError("usage", `--${name} takes a number, not ${JSON.stringify(value)}`);
        options[name] = number;
      } else if (option.type === "list") {
        options[name] = [...((options[name] as string[] | undefined) ?? []), value];
      } else options[name] = value;
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") throw new CliError("usage", `Unknown option ${arg} (put -- before text that starts with a dash)`);
    positionals.push(arg);
  }
  return { positionals, options };
}

/**
 * Global options given before the command (`ghostly --profile bot send …`) move after it, where every command's
 * parser reads them. Stops at `--` and at the first word that is not a global option.
 */
export function liftGlobals(argv: readonly string[]): string[] {
  const lifted: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const name = arg.startsWith("--") ? arg.slice(2, eq === -1 ? undefined : eq) : arg.length === 2 && arg.startsWith("-") ? Object.entries(GLOBAL_OPTIONS).find(([, o]) => o.short === arg.slice(1))?.[0] : undefined;
    const option = name ? GLOBAL_OPTIONS[name] : undefined;
    if (!option || arg === "--") break;
    const takesValue = option.type !== "boolean" && eq === -1;
    lifted.push(...argv.slice(i, i + (takesValue ? 2 : 1)));
    i += takesValue ? 2 : 1;
  }
  const rest = argv.slice(i);
  const end = rest.indexOf("--");
  return end === -1 ? [...rest, ...lifted] : [...rest.slice(0, end), ...lifted, ...rest.slice(end)];
}
