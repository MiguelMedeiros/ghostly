import { CliError } from "./errors";

const OFF = /^(0|false|off|no)$/i, ON = /^(1|true|on|yes)$/i;

/**
 * An on/off environment switch (`GHOSTLY_DHT`, `GHOSTLY_STUN`, `GHOSTLY_WEBRTC`, `GHOSTLY_HUB`): unset or empty is
 * `fallback`; 0/false/off/no and 1/true/on/yes, in any case and trimmed, say it; anything else is a usage error naming
 * the variable. Before, only the exact "0" turned one off: `GHOSTLY_DHT=false` kept the profile on the public Mainline
 * DHT, and `GHOSTLY_STUN=off` kept asking Google's STUN servers, with no word (agents#1756). A privacy switch never
 * fails open in silence.
 */
export function envSwitch(name: string, fallback: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[name];
  if (value === undefined || value.trim() === "") return fallback;
  if (OFF.test(value.trim())) return false;
  if (ON.test(value.trim())) return true;
  throw new CliError("usage", `${name} takes 0 or 1 (or false/true, off/on, no/yes), not ${JSON.stringify(value)}`);
}
