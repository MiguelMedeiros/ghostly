/** A fake engine's `chatView`, read from its own `getState` as the engine's is (`GhostlyNode.chatView`). */
export function chatViewOf(this: { getState(): unknown }, id: string): unknown {
  return (this.getState() as { links?: { id: string }[] }).links?.find((link) => link.id === id);
}

/** A fake engine's `groupView`, read from its own `getState` as the engine's is (`GhostlyNode.groupView`). */
export function groupViewOf(this: { getState(): unknown }, id: string): unknown {
  return (this.getState() as { groups?: { id: string }[] }).groups?.find((group) => group.id === id);
}
