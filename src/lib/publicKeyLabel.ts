/** Display only: copying, signing and invites must keep the original value. */
export function publicKeyLabel(key: string): string {
  return key.length <= 15 ? key : `${key.slice(0,6)}...${key.slice(-6)}`;
}
