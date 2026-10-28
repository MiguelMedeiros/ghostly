/**
 * Whether auto-translation in chats is in this build: `VITE_TRANSLATE=1`, fixed when the build is made, never read at
 * runtime from storage or the address. Only a development build carries it (apps/web/translateFlag.ts refuses it in
 * an image, a Desktop release and the extension build), so while it is off nothing of the feature shows: no Settings
 * row, no line in a bubble, no translation runtime started. Every screen asks here.
 */
export function translateEnabled(): boolean {
  return import.meta.env?.VITE_TRANSLATE === "1";
}
