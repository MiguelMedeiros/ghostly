/**
 * A profile picture as it travels between paired peers: a small square JPEG in a data URL. The picture
 * a contact sends is shown next to their chats, so it is checked here before anything draws it: the
 * format, the size, and the dimensions its header declares (a tiny file can claim a huge image).
 */

/** Longest data URL kept: a 128×128 JPEG is a few KB; this leaves room and no more. */
export const MAX_AVATAR_LENGTH = 48_000;
/** Largest side a picture may declare. What Ghostly sends is 128. */
export const MAX_AVATAR_SIDE = 512;
const PREFIX = "data:image/jpeg;base64,";

/** Width and height from a JPEG's frame header, or undefined when there is none before the image data. */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return;
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) return;
    const marker = bytes[i + 1];
    i += 2;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
    if (marker === 0xd9 || marker === 0xda) return;
    const size = (bytes[i] << 8) | bytes[i + 1];
    if (size < 2 || i + size > bytes.length) return;
    // Start-of-frame markers (baseline, progressive, …), not DHT/JPG/DAC.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc && size >= 7)
      return { height: (bytes[i + 3] << 8) | bytes[i + 4], width: (bytes[i + 5] << 8) | bytes[i + 6] };
    i += size;
  }
}

/**
 * The picture if it is one Ghostly will show, `null` for "no picture" (an empty string), and undefined
 * for anything else, which is ignored.
 */
export function sanitizeAvatar(value: unknown): string | null | undefined {
  if (value === "" || value === null) return null;
  if (typeof value !== "string" || value.length > MAX_AVATAR_LENGTH || !value.startsWith(PREFIX)) return;
  const data = value.slice(PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 !== 0) return;
  let binary: string;
  try { binary = atob(data); } catch { return; }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const size = jpegSize(bytes);
  if (!size || size.width < 1 || size.height < 1 || size.width > MAX_AVATAR_SIDE || size.height > MAX_AVATAR_SIDE) return;
  return value;
}
