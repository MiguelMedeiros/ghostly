import type { NostrProfileView } from "../nostr/types";
import type { PublicProfileView } from "./types";

/**
 * Where a picture sits deeper in a list's item (`copyingSink` leaves it out, `keptState` puts it back): the item's name
 * in its list, the picture, and the item with another picture (`undefined`: none).
 */
export interface PictureAt<U> {
  key: (item: U) => string;
  get: (item: U) => string | undefined;
  set: <T extends U>(item: T, picture: string | undefined) => T;
}

function withAvatar<T extends { avatar?: string }>(view: T, avatar: string | undefined): T {
  const { avatar: _, ...without } = view;
  return (avatar === undefined ? without : { ...without, avatar }) as T;
}

/** A verified identity's public profile picture: this profile's (`identityProofs`) or a contact's (`identities.received`), by proof id. */
export const identityPicture: PictureAt<{ id: string; publicProfile?: PublicProfileView }> = {
  key: (proof) => proof.id,
  get: (proof) => proof.publicProfile?.avatar,
  set: (proof, avatar) => (proof.publicProfile ? { ...proof, publicProfile: withAvatar(proof.publicProfile, avatar) } : proof),
};

/** A Nostr key's profile picture: this profile's (`nostr.own`) or a contact's (a chat's `nostr`), by key. */
export const nostrPicture: PictureAt<{ subject: string; profile?: { profile?: NostrProfileView } }> = {
  key: (view) => view.subject,
  get: (view) => view.profile?.profile?.avatar,
  set: (view, avatar) => (view.profile?.profile ? { ...view, profile: { ...view.profile, profile: withAvatar(view.profile.profile, avatar) } } : view),
};

/** The list with the pictures `keys` names put back from the list before, each the one it was sent last. */
export function picturesBack<T extends U, U>(list: T[], keys: string[] | undefined, had: T[] | undefined, at: PictureAt<U>): T[] {
  if (!keys?.length) return list;
  const names = new Set(keys), pictures = new Map((had ?? []).map((item) => [at.key(item), at.get(item)]));
  return list.map((item) => (names.has(at.key(item)) ? at.set(item, pictures.get(at.key(item))) : item));
}
