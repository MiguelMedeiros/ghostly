/**
 * Which of two released versions is newer. Every client asks this of whatever
 * it found published, so a malformed answer must never read as an update: the
 * numbers are the only thing trusted here, and anything else sorts as older.
 */

/** `1.2.3`, with an optional `v` and an optional `-beta.1` this ignores. */
const RELEASE = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:[-+].*)?$/;

function parse(version: string): [number, number, number] | null {
  const match = RELEASE.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Negative when `a` is older, positive when it is newer, 0 when they match or either is not a version. */
export function compareVersions(a: string, b: string): number {
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return 0;
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

/** Whether `latest` is worth updating to from `current`. Unparseable input is never an update. */
export function isNewerVersion(latest: string, current: string): boolean {
  return compareVersions(latest, current) > 0;
}
