/**
 * The contacts' apps this device opened on the web, by profile and chat, so what each kept on its origin (its storage,
 * its caches, the services worker) goes when the chat is deleted, the profile's data is cleared or the profile is
 * deleted. The origin is named from the chat's key: a later chat never opens it again, so nothing else would clear it.
 */
import { MAX_SERVICES, viewerTag } from "@ghostly/core";
import type { LinkView } from "@ghostly/browser/shared/types";
import { openedServices as openedList, type ForgetServices, type Opened } from "../../../ui/src/lib/openedServices";
import { serviceLabel } from "./opener";
import { BRIDGE_CLEAR, BRIDGE_CLEARED, BRIDGE_PAGE, BRIDGE_READY, LABEL, serviceOrigin, type ServicesHost } from "./protocol";

export { OPENED_KEY, type ForgetServices } from "../../../ui/src/lib/openedServices";
/** How long one origin's bridge may take to load and clear it before the rest goes on without it. */
export const CLEAR_ORIGIN_MS = 10_000;

/** One contact's app this device opened: the profile, the chat and its label (`serviceLabel`, its origin's name). */
export interface OpenedService extends Opened { label: string }

const opened = openedList<OpenedService>((o) => typeof o.label === "string" && LABEL.test(o.label), (a, b) => a.label === b.label);

export const openedServices = (): OpenedService[] => opened.list();

/** Noted before the app opens: whatever it keeps there from then on is cleared with the chat. */
export const noteOpened = (service: OpenedService): void => opened.note(service);

/** `<profile> <chat key> <contact> <app>` of each app this page noted from a chat's list: each one once. */
const listed = new Set<string>();

/**
 * Notes every app each chat lists (`peerServices`), as the list comes: one this device opened before the list was kept
 * (it noted only those it opened from then on) goes with the chat, its data or its profile too. Only a contact who
 * comes back online lists theirs again, so only theirs are found. No more for a chat than one list holds
 * (`MAX_SERVICES`): a contact may list new apps at any time, and the list is local storage the whole origin shares,
 * each entry a bridge Delete chat loads at once.
 */
export async function noteListed(profile: string, links: readonly Pick<LinkView, "myPubKeyZ32" | "peerPubKeyZ32" | "peerServices">[]): Promise<void> {
  for (const link of links) {
    for (const service of link.peerServices ?? []) {
      if (service.type !== "http") continue;
      const key = `${profile} ${link.myPubKeyZ32} ${link.peerPubKeyZ32} ${service.id}`;
      if (listed.has(key)) continue;
      listed.add(key);
      const tag = viewerTag(link.myPubKeyZ32);
      const label = await serviceLabel(tag, link.peerPubKeyZ32, service.id);
      // Counted right before it is noted, with no wait between: two states noted at once never both pass the count.
      if (opened.list().filter((o) => o.profile === profile && o.tag === tag).length >= MAX_SERVICES) continue;
      opened.note({ profile, tag, label });
    }
  }
}

/** Loads the bridge on `origin` in a frame no one sees and has it clear the origin: true once it says it did. */
function clearOrigin(origin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.style.cssText = "position:fixed;width:0;height:0;border:0;visibility:hidden";
    const done = (cleared: boolean) => {
      clearTimeout(timer);
      removeEventListener("message", onMessage);
      frame.remove();
      resolve(cleared);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || event.origin !== origin) return;
      const type = (event.data as { type?: unknown } | null)?.type;
      if (type === BRIDGE_READY) frame.contentWindow!.postMessage({ type: BRIDGE_CLEAR }, origin);
      else if (type === BRIDGE_CLEARED) done(true);
    };
    const timer = setTimeout(() => done(false), CLEAR_ORIGIN_MS);
    addEventListener("message", onMessage);
    frame.src = `${origin}${BRIDGE_PAGE}`;
    document.body.append(frame);
  });
}

/**
 * Clears the origins of the contacts' apps opened from one chat (`tag`) or by one profile (`profile`), all at once, and
 * takes each one cleared off the list. One whose bridge did not answer stays on it, for the profile's next clear
 * (a deleted profile's: `forgetServicesOfGone`; a deleted chat's: `forgetServicesOfChatsGone`). At once, as Clear all
 * data and Delete profile wait for it: offline, where no bridge loads, that is one `CLEAR_ORIGIN_MS`, not one per app
 * the profile opened.
 */
export function forgetServices(host: ServicesHost, which: ForgetServices): Promise<void> {
  return opened.forget(which, (service) => clearOrigin(serviceOrigin(host, service.label)), true);
}

/**
 * Clears the origins of the apps opened by profiles no longer `listed`: one deleted while its bridges could not be
 * reached (offline, the services host down) has no clear of its own to come. Each start and each return online tries
 * again, until each is cleared and off the list.
 */
export async function forgetServicesOfGone(host: ServicesHost, listed: readonly string[]): Promise<void> {
  for (const profile of new Set(opened.list().map((o) => o.profile).filter((p) => !listed.includes(p)))) await forgetServices(host, { profile });
}

/**
 * Clears the origins of the apps `profile` opened from chats it no longer has (`tags`: the `viewerTag` of each it has,
 * every one of them, so never before its chats are all loaded). One deleted while its bridges could not be reached
 * (offline, the services host down, the tab closed during the clear) has no clear of its own to come either.
 */
export async function forgetServicesOfChatsGone(host: ServicesHost, profile: string, tags: readonly string[]): Promise<void> {
  for (const tag of new Set(opened.list().filter((o) => o.profile === profile && !tags.includes(o.tag)).map((o) => o.tag))) await forgetServices(host, { tag });
}
