/** Display only: copying, signing and invites must keep the original value. */
export function publicKeyLabel(key: string): string {
  return key.length <= 15 ? key : `${key.slice(0,6)}...${key.slice(-6)}`;
}

/**
 * The end of a key as a name shown with it reads it, "(…k1p0aa)": isolated left to right (LRI … PDI), so in an Arabic
 * line it is not laid out as "(k1p0aa…)", the end read as its start.
 */
export function keyEnd(key: string): string {
  return `\u2066(…${key.slice(-6)})\u2069`;
}

/** What a contact with no name goes by ("Contact · 1kwb54"): the start of their key, so it never changes. */
export function contactTag(key: string): string {
  return key.slice(0, 6);
}
