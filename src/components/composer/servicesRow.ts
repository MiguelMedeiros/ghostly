import type { Translate } from "../../contexts/I18nContext";
import type { ServicesPlatform } from "../../lib/platform";
import { servicesBlock, servicesUnavailable } from "../../lib/servicesAvailability";

/** The composer's Shared services row, as a chat hands it to MessageInput. */
export interface ComposerServices {
  /** Opens the chat's ChatServicesDialog for this contact. */
  onOpen: () => void;
  /** Why nothing can be chosen in it: the row stays, greyed, saying so. */
  unavailable?: string;
  /** What it says on hover while it opens (the row stays one line). */
  hint?: string;
}

/**
 * The + row that opens this contact's shared services (ChatServicesDialog): in a chat the platform knows the contact of,
 * or none. Greyed only where nothing in it can be chosen: this app can neither share nor open apps (the web app), or
 * the contact's app cannot. Otherwise it opens, so a first app can be granted before the chat is live, and its hover
 * title says why apps cannot travel yet, or how many are shared either way.
 */
export function composerServices(t: Translate, platform: ServicesPlatform | null, peerKey: string, name: string, onOpen: () => void): ComposerServices | undefined {
  const peer = platform?.getPeer(peerKey);
  if (!platform || !peer) return undefined;
  const { shareLocalServices, openServices } = platform.features;
  if (!shareLocalServices && !openServices) return { onOpen, unavailable: t("composer.servicesNeedApp") };
  const why = servicesUnavailable(peer, name) ?? undefined;
  if (servicesBlock(peer) === "contact-cannot") return { onOpen, unavailable: why };
  const mine = shareLocalServices ? platform.getSharedServices().filter((s) => s.enabled && s.sharedWith?.includes(peerKey)).length : 0;
  const shared = mine + (peer.services ?? []).filter((s) => s.type === "http").length;
  return { onOpen, hint: why ?? (shared ? t("composer.servicesShared", { count: shared }) : undefined) };
}
