import { androidApp } from "./touchOnly";

/**
 * Whether auto-translation in chats is in this build: `VITE_TRANSLATE=1`, fixed when the build is made, never read at
 * runtime from storage or the address. The Desktop app's builds carry it from 1.7.0 (apps/web/translateFlag.ts refuses
 * it in an image, the Android app's and the extension build), and the Android app never shows it, even in a build made
 * with it: the first version is Desktop only. While it is off nothing of the feature shows: no Settings row, no line in
 * a bubble, no translation runtime started. Every screen asks here.
 */
export function translateEnabled(): boolean {
  return import.meta.env?.VITE_TRANSLATE === "1" && !androidApp();
}
