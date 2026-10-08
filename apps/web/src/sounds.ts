import { setSoundsRelease } from "../../ui/src/lib/sounds";
import { browserSoundsRelease } from "../../ui/src/lib/webkitGtk";

/**
 * In a WebKitGTK browser (GNOME Web and the like) before 2.52, the sounds' output is kept running between sounds, as
 * the Linux Desktop does: there waking a suspended output holds the page for seconds. Elsewhere nothing changes.
 * At start, before the first sound.
 */
export function gateSounds(...args: Parameters<typeof browserSoundsRelease>): void {
  const release = browserSoundsRelease(...args);
  if (release) setSoundsRelease(release);
}
