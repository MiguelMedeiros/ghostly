import type { StoredService } from "../shared/types";

/**
 * The one place that decides whether a contact may reach a service.
 *
 * Both the advertisement and the side that serves ask this. Filtering the
 * advertisement alone would not be an authorization: a contact that saw an id
 * once, or guessed one, would still be served. A service reaches a contact only
 * when it is running and that contact was granted it by name — there is no
 * value of `sharedWith` that means everyone.
 */
export function mayReach(service: StoredService, peerPubKeyZ32: string): boolean {
  return service.enabled && !!peerPubKeyZ32 && !!service.sharedWith?.includes(peerPubKeyZ32);
}
