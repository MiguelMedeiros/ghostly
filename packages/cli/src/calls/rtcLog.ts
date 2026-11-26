import type { LogLevel } from "node-datachannel";

/**
 * `GHOSTLY_RTC_LOG=<level>`: libdatachannel's and libjuice's own lines (each STUN check sent and received, each remote
 * candidate added, each ICE state) in the process's stderr, as `ghostly: rtc <level>: …`. For finding why a call's
 * ICE never connects (the e2e on macOS turns it on for its bot), not needed to run, and off unless set: unset, empty
 * or not one of libdatachannel's levels leaves node-datachannel's logger untouched.
 *
 * The lines go to logs others read (a CI job's), so what would let someone into a connection is cut out first: ICE
 * passwords and user fragments (an SDP's `a=ice-pwd`, libjuice's `pwd="…"`, a failed check's `password="…"`), STUN and
 * TURN user names, realms and nonces, DTLS fingerprints. Addresses and ports stay: they are what the log is for.
 *
 * node-datachannel's `cleanup()` (`rtcThreads`) drops the logger's callback, so it is set again after each one; and
 * the callback holds the process open until a `cleanup()`, which the CLI never waits on (every command and the daemon
 * leave by `process.exit`).
 */
const LEVELS: readonly LogLevel[] = ["Verbose", "Debug", "Info", "Warning", "Error", "Fatal"];

/** `GHOSTLY_RTC_LOG`'s level, in any case, or null (no log) for anything else. */
export function rtcLogLevel(value: string | undefined): LogLevel | null {
  const wanted = value?.trim().toLowerCase();
  return (wanted && LEVELS.find((level) => level.toLowerCase() === wanted)) || null;
}

const HIDDEN = "<hidden>";
const CUTS: readonly [RegExp, string][] = [
  // SDP lines (a description libdatachannel or libjuice prints whole): `a=ice-pwd:…`, `a=fingerprint:sha-256 …`.
  [/\b(a=(?:ice-pwd|ice-ufrag|fingerprint|crypto)):[^\r\n]*/gi, `$1:${HIDDEN}`],
  // libjuice's `ufrag="…", pwd="…"`, `password="…"`, `username="…"`, a failed check's `expected="…", actual="…"`.
  [/\b(ice-pwd|ice-ufrag|pwd|password|ufrag|username|credential|expected|actual|realm|nonce)=("[^"]*"|[^\s,]+)/gi, `$1=${HIDDEN}`],
  // `Got username: …`, `Got nonce: …`, `for username "…"`, a candidate's `ufrag …` (Chrome's and WebKit's extension).
  [/\b(username|realm|nonce):[ \t]*[^\s,]+/gi, `$1: ${HIDDEN}`],
  [/\b(username|realm|nonce|fingerprint)[ \t]+"[^"]*"/gi, `$1 "${HIDDEN}"`],
  [/\b(ufrag|pwd)[ \t]+(?!check\b)[^\s,]+/gi, `$1 ${HIDDEN}`],
  // Any fingerprint the forms above missed: 16 or more hex pairs joined by colons.
  [/\b(?:[0-9a-f]{2}:){15,}[0-9a-f]{2}\b/gi, HIDDEN],
  [/\b(Sec-WebSocket-(?:Key|Accept)):[ \t]*\S+/gi, `$1: ${HIDDEN}`],
];

/**
 * At Verbose, libjuice's ICE work (each STUN check sent and received, its answer, each candidate and pair) comes with
 * both libraries' lines on every datagram, some 20 for each: a call's audio made over 2,000 lines a second. From that
 * level only the ICE agent's own lines are kept; every other level is kept whole.
 */
const VERBOSE_KEPT = /Received STUN datagram|STUN entry \d+:|STUN Binding|check (?:succeeded|failed)|STUN username|nominat|pair|candidate|resolv|description|TURN|Remote agent|socket bound/i;

/** Whether a line at `level` goes out (see VERBOSE_KEPT). */
export function rtcLogKept(level: string, message: string): boolean {
  return level !== "Verbose" || VERBOSE_KEPT.test(message);
}

/** One of libdatachannel's lines with its secrets cut out (see the module's note). */
export function rtcLogLine(message: string): string {
  return CUTS.reduce((text, [pattern, to]) => text.replace(pattern, to), message);
}

/**
 * Turns the log on at `GHOSTLY_RTC_LOG`'s level, if set: whether it did. A logger that cannot be set (an older
 * node-datachannel) leaves calls as they were.
 */
export function startRtcLog(
  lib: { initLogger(level: LogLevel, cb?: (level: LogLevel, message: string) => void): void },
  env: NodeJS.ProcessEnv = process.env,
  write: (text: string) => void = (text) => { process.stderr.write(text); },
): boolean {
  const level = rtcLogLevel(env.GHOSTLY_RTC_LOG);
  if (!level) return false;
  try {
    // A description comes as one message of many lines: each goes on its own line under the first, indented.
    lib.initLogger(level, (said, message) => {
      if (rtcLogKept(said, message)) write(`ghostly: rtc ${said}: ${rtcLogLine(message).split(/\r?\n|\r/).filter(Boolean).join("\n  ")}\n`);
    });
    return true;
  } catch {
    return false;
  }
}
