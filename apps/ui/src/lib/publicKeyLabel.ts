/** Display only: copying, signing and invites must keep the original value. */
export function publicKeyLabel(key: string): string {
  return key.length <= 15 ? key : `${key.slice(0,6)}...${key.slice(-6)}`;
}

/** What a contact with no name goes by ("Contact · 1kwb54"): the start of their key, so it never changes. */
export function contactTag(key: string): string {
  return key.slice(0, 6);
}
