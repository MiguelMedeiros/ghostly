import { CliError } from "./errors";

export type OptionType = "string" | "number" | "boolean" | "list";
export interface OptionSpec {
  type: OptionType; short?: string; description: string;
  /** A number option that may stand alone (then `true`): it takes the next word only when that is a number. */
  optionalValue?: boolean;
  /** What a number option takes, as its refusal says it (`a length in milliseconds`); default "a number". */
  takes?: string;
  /** A boolean the command takes only as `--no-<name>`: help shows it so. */
  negatedOnly?: boolean;
  /** A boolean whose usage shows `[--<name> | --no-<name>]`: both ways on one line are a usage error, not the last. */
  eitherWay?: boolean;
  /**
   * The words a string option takes: any other (or "") is a usage error that names the flag and lists them, before the
   * profile opens. Before, the API answered it ("network must be one of mainnet, testnet", bad_request, exit 1).
   */
  choices?: readonly string[];
}
export interface Parsed { positionals: string[]; options: Record<string, string | number | boolean | string[] | undefined> }

/**
 * A number as typed on the command line, in decimal digits only (`21`, `-5`, `12.5`); NaN for any other word.
 * `Number()` alone read `1e3` as 1,000, `0x10` as 16 and `" 21"` as 21: `chat pay bob 2e3`, a typo of 23, paid 2,000.
 */
export const decimalNumber = (value: string): number => /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : NaN;
const notANumber = (name: string, option: OptionSpec, value: string) => new CliError("usage", `--${name} takes ${option.takes ?? "a number"}, not ${JSON.stringify(value)}`);

/**
 * The word right after an option that stood alone because it was no number (`--voice 2s`), by the positionals a parse
 * returned: should the line have one too many, that word was the option's value, and `strayValue` says so.
 */
const lonelyValues = new WeakMap<readonly string[], { index: number; word: string; refusal: CliError }[]>();

/** The refusal of an option's value that was taken as a positional (`--voice 2s`), else undefined. */
export function strayValue(values: readonly string[]): CliError | undefined {
  return lonelyValues.get(values)?.find(({ index, word }) => values[index] === word)?.refusal;
}
/**
 * The command a line is parsed for, as its unknown options name it: `send`, whether text comes on its line, and which
 * positionals take a number (`<sats>`): there a word like `-5` is that number, refused as one, not an unknown option.
 */
export interface ParseFor { command: string; text?: boolean; number?: (index: number) => boolean }

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
 * the ghostly-cli lesson of #208). So is a positional that `idSlot` says takes an id, a key or a draft: there a word
 * that starts with `-`, is longer than two characters and is no option of the command is the value (`--` starts one
 * id in 4096; `-x` stays an option). Any other positional that starts with `-` is refused instead of sent: a
 * mistyped flag must not reach a contact as text. Put `--` before a message that starts with a dash. Where `parsing`
 * says a number comes, a word of a dash and a digit (`-5`) that is no option is that number, for the command to refuse
 * in its own words (`<sats> takes a whole number from 1 up, not -5`); no option's name starts with a digit.
 *
 * An unknown option names the command `parsing` gives, the nearest of its options and its help.
 */
export function parseArgs(argv: readonly string[], spec: Record<string, OptionSpec>, idSlot: (index: number) => boolean = () => false, parsing?: ParseFor): Parsed {
  const all = { ...GLOBAL_OPTIONS, ...spec };
  const byShort = new Map(Object.entries(all).filter(([, s]) => s.short).map(([name, s]) => [s.short!, name]));
  const isOption = (arg: string) => {
    if (!arg.startsWith("--")) return arg.length === 2 && byShort.has(arg.slice(1));
    const name = arg.slice(2).split("=")[0];
    return Object.hasOwn(all, name) || (name.startsWith("no-") && all[name.slice(3)]?.type === "boolean");
  };
  const positionals: string[] = [];
  const lonely: { index: number; word: string; refusal: CliError }[] = [];
  const options: Parsed["options"] = {};
  const setBoolean = (name: string, value: boolean) => {
    if (all[name].eitherWay && options[name] !== undefined && options[name] !== value) throw new CliError("usage", `--${name} or --no-${name}, not both`);
    options[name] = value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") { positionals.push(...argv.slice(i + 1)); break; }
    if (/^-\d/.test(arg) && parsing?.number?.(positionals.length) && !isOption(arg)) { positionals.push(arg); continue; }
    if (arg.startsWith("-") && arg.length > 2 && idSlot(positionals.length) && !isOption(arg)) { positionals.push(arg); continue; }
    if (arg.startsWith("--") || (arg.startsWith("-") && arg.length === 2 && arg !== "-")) {
      let name: string, inline: string | undefined;
      if (arg.startsWith("--")) {
        const eq = arg.indexOf("=");
        name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
        inline = eq === -1 ? undefined : arg.slice(eq + 1);
      } else {
        const long = byShort.get(arg.slice(1));
        if (!long) throw unknownOption(arg, all, parsing);
        name = long;
      }
      if (name.startsWith("no-") && all[name.slice(3)]?.type === "boolean") {
        // `--no-pretty=true` was an unknown option whose nearest name was `--no-pretty`, the word typed.
        if (inline !== undefined) throw new CliError("usage", `--${name} takes no value`);
        setBoolean(name.slice(3), false);
        continue;
      }
      const option = all[name];
      if (!option) throw unknownOption(`--${name}`, all, parsing);
      if (option.type === "boolean") {
        if (inline !== undefined && !["true", "false"].includes(inline)) throw new CliError("usage", `--${name} takes no value`);
        setBoolean(name, inline === undefined || inline === "true");
        continue;
      }
      let value = inline;
      // An empty word after it is its value, refused below: `--voice "$MS"` with MS unset, not a positional ("Too many
      // arguments", or "Missing <path>" with the path given). Number("") is 0, so it is taken here.
      if (value === undefined && option.optionalValue && !(i + 1 < argv.length && Number.isFinite(Number(argv[i + 1])))) {
        options[name] = true;
        const next = argv[i + 1];
        if (next && !next.startsWith("-")) lonely.push({ index: positionals.length, word: next, refusal: notANumber(name, option, next) });
        continue;
      }
      if (value === undefined) {
        if (i + 1 >= argv.length) throw new CliError("usage", `--${name} needs a value`);
        value = argv[++i];
      }
      if (option.type === "number") {
        // Number("") and Number(" ") are 0: an unset variable must not read as 0 and be acted on.
        const number = decimalNumber(value);
        if (!Number.isFinite(number)) throw notANumber(name, option, value);
        options[name] = number;
      } else if (option.type === "list") {
        options[name] = [...((options[name] as string[] | undefined) ?? []), value];
      } else {
        if (option.choices && !option.choices.includes(value)) throw new CliError("usage", `--${name} takes ${listed(option.choices)}, not ${JSON.stringify(value)}`);
        options[name] = value;
      }
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") throw unknownOption(arg, all, parsing);
    positionals.push(arg);
  }
  if (lonely.length) lonelyValues.set(positionals, lonely);
  return { positionals, options };
}

/**
 * `Unknown option --wiat for ghostly send (did you mean --wait? ghostly help send)`. The `--` hint only where text comes
 * and for a word with one dash, which may be text (`-1`, `-x`): `version -x` has no text to put after `--`.
 */
function unknownOption(arg: string, all: Record<string, OptionSpec>, parsing: ParseFor | undefined, help = parsing ? `ghostly help ${parsing.command}` : undefined): CliError {
  const names = Object.entries(all).flatMap(([name, o]) => (o.type === "boolean" ? [name, `no-${name}`] : [name]));
  const near = nearest(arg.replace(/^--?/, ""), names);
  const hints = [
    ...(near ? [`did you mean --${near}?`] : []),
    ...(parsing?.text && /^-[^-]/.test(arg) ? ["put -- before text that starts with a dash;"] : []),
    ...(help ? [help] : []),
  ];
  return new CliError("usage", `Unknown option ${arg}${parsing ? ` for ghostly ${parsing.command}` : ""}${hints.length ? ` (${hints.join(" ")})` : ""}`);
}

/**
 * A first word that starts with a dash and is no global option (`ghostly --porfile bot send …`, `ghostly -x status`):
 * `Unknown option --porfile (did you mean --profile? ghostly help)`, as after the command. Before, "Unknown command".
 */
export function unknownGlobalOption(arg: string): CliError {
  return unknownOption(arg.startsWith("--") ? arg.split("=")[0] : arg, GLOBAL_OPTIONS, undefined, "ghostly help");
}

/**
 * The word of `words` a typo most likely meant: the nearest by Damerau-Levenshtein distance (a letter added, dropped,
 * changed or two swapped), at most 2 and at most a third of the word's length (`wiat` one: `nope` is not `home`; `-x`
 * none), else undefined.
 */
export function nearest(typed: string, words: Iterable<string>): string | undefined {
  const most = Math.min(2, Math.floor(typed.length / 3));
  let best: string | undefined, bestDistance = most + 1;
  for (const word of words) {
    // The distance is at least the lengths' difference: a long text that starts with a dash builds no table per name.
    if (Math.abs(typed.length - word.length) >= bestDistance) continue;
    const d = distance(typed, word);
    if (d < bestDistance) { best = word; bestDistance = d; }
  }
  return best;
}

/** The optimal string alignment distance: the edits that turn `a` into `b`, a swap of two neighbours one of them. */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** The kind of value each key `settings set` takes has (api.ts `SETTABLE`). */
export type SettingKind = "strings" | "string" | "boolean" | "ice";
const SETTINGS_SET = "ghostly settings set <key> <json-value> [--force]";

/**
 * A key `settings set` does not take is a usage error that names the nearest one (whatever its case: `sendtyping`)
 * and lists them, before stdin is read and the profile opens. Before, the API answered it once a one-shot was online
 * (bad_request, exit 1), with no "did you mean". The API keeps its own check for a socket's callers.
 */
export function checkSettingKey(key: string, kinds: Record<string, SettingKind>): SettingKind {
  if (Object.hasOwn(kinds, key)) return kinds[key];
  const byLower = new Map(Object.keys(kinds).map((name) => [name.toLowerCase(), name]));
  const near = byLower.get(nearest(key.toLowerCase(), byLower.keys()) ?? "");
  throw new CliError("usage", `${key} is not a setting the CLI changes${near ? ` (did you mean ${near}?)` : ""}: ghostly settings set takes ${Object.keys(kinds).join(", ")} (ghostly help settings set)`);
}

/** A value of another kind than its key takes (`online maybe`): a usage error too, before the profile opens. */
export function checkSettingValue(key: string, kind: SettingKind, value: unknown, typed: string): void {
  if (kind === "boolean" && typeof value !== "boolean") throw new CliError("usage", `${key} takes true or false, not ${JSON.stringify(typed)}: ${SETTINGS_SET}`);
  // Not echoed: a TURN password may be in it.
  if (kind === "strings" && !(Array.isArray(value) && value.every((v) => typeof v === "string"))) throw new CliError("usage", `${key} takes a JSON list of strings: ${SETTINGS_SET}`);
  if (kind === "ice" && !(Array.isArray(value) && value.every((v) => v && typeof v === "object"))) throw new CliError("usage", `${key} takes a JSON list of ICE servers: ${SETTINGS_SET}`);
}

/** Words as a sentence lists them: "a", "a or b", "a, b or c". */
const listed = (words: readonly string[]) => (words.length > 1 ? `${words.slice(0, -1).join(", ")} or ${words.at(-1)}` : words[0]);

/** The global option a word names (`--profile`, `--profile=bot`, `-p`), else undefined. */
export function globalOption(arg: string): OptionSpec | undefined {
  const name = globalName(arg);
  return name ? GLOBAL_OPTIONS[name] : undefined;
}

/** The name of the global option a word names (`profile` for `-p`, `pretty` for `--no-pretty`), else undefined. */
function globalName(arg: string): string | undefined {
  const eq = arg.indexOf("=");
  const name = arg.startsWith("--") ? arg.slice(2, eq === -1 ? undefined : eq) : arg.length === 2 && arg.startsWith("-") ? Object.entries(GLOBAL_OPTIONS).find(([, o]) => o.short === arg.slice(1))?.[0] : undefined;
  if (name && Object.hasOwn(GLOBAL_OPTIONS, name)) return name;
  // A boolean's `--no-` form, as the parser reads it (with no value): before, `ghostly --no-pretty status` was no command.
  const negated = name?.startsWith("no-") && eq === -1 ? name.slice(3) : undefined;
  return negated && GLOBAL_OPTIONS[negated]?.type === "boolean" ? negated : undefined;
}

/**
 * Global options given before the command (`ghostly --profile bot send …`) move after it, where every command's
 * parser reads them. Stops at `--` and at the first word that is not a global option. They go before the first word
 * after the command's that starts with a dash (its first option, or the `--` that ends them), else at the end: never
 * between an option and its value, which may itself be `--` (`--pretty profile set --name --`). One that takes a value
 * and is the last word has none: a usage error.
 */
export function liftGlobals(argv: readonly string[]): string[] {
  const lifted: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const option = globalOption(arg);
    if (!option || arg === "--") break;
    const takesValue = option.type !== "boolean" && eq === -1;
    // `ghostly -p` alone: a usage error, as `ghostly send -p` is, not the help a line of global options alone shows.
    if (takesValue && i + 1 >= argv.length) throw new CliError("usage", `--${globalName(arg)} needs a value`);
    lifted.push(...argv.slice(i, i + (takesValue ? 2 : 1)));
    i += takesValue ? 2 : 1;
  }
  const rest = argv.slice(i);
  // The first word is the command, also when it is `--version` or `--help`; a `--` there ends the options at once.
  const dash = rest[0] === "--" ? 0 : rest.findIndex((word, i) => i > 0 && word.startsWith("-"));
  return dash === -1 ? [...rest, ...lifted] : [...rest.slice(0, dash), ...lifted, ...rest.slice(dash)];
}
