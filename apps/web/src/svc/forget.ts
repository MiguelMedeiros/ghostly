/**
 * The contacts' apps this device opened on the web, by profile and chat, so what each kept on its origin (its storage,
 * its caches, the services worker) goes when the chat is deleted, the profile's data is cleared or the profile is
 * deleted. The origin is named from the chat's key: a later chat never opens it again, so nothing else would clear it.
 */
import { BRIDGE_CLEAR, BRIDGE_CLEARED, BRIDGE_PAGE, BRIDGE_READY, LABEL, serviceOrigin, type ServicesHost } from "./protocol";

/** Not under any profile's prefix (`ghostly_`): the list outlives one profile's Clear all data, and holds every profile's. */
export const OPENED_KEY = "ghostly-services-opened";
/** How long one origin's bridge may take to load and clear it before the rest goes on without it. */
export const CLEAR_ORIGIN_MS = 10_000;

/** One contact's app this device opened: the profile (its id), the chat (`viewerTag` of this side's key) and its label. */
export interface OpenedService { profile: string; tag: string; label: string }
export type ForgetServices = { tag: string } | { profile: string };

export function openedServices(): OpenedService[] {
  try {
    const list = JSON.parse(localStorage.getItem(OPENED_KEY) ?? "[]") as unknown;
    return Array.isArray(list) ? list.filter((o): o is OpenedService => !!o && typeof o.profile === "string" && typeof o.tag === "string" && typeof o.label === "string" && LABEL.test(o.label)) : [];
  } catch { return []; }
}

function save(list: OpenedService[]): void {
  try {
    if (list.length) localStorage.setItem(OPENED_KEY, JSON.stringify(list));
    else localStorage.removeItem(OPENED_KEY);
  } catch { /* storage full: the open goes on, its origin is only not cleared later */ }
}

/** Noted before the app opens: whatever it keeps there from then on is cleared with the chat. */
export function noteOpened(opened: OpenedService): void {
  const list = openedServices();
  if (!list.some((o) => o.label === opened.label)) save([...list, opened]);
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
 * Clears the origins of the contacts' apps opened from one chat (`tag`) or by one profile (`profile`), one at a time,
 * and takes each one cleared off the list. One whose bridge did not answer stays on it, for the profile's next clear.
 */
export async function forgetServices(host: ServicesHost, which: ForgetServices): Promise<void> {
  const matches = (o: OpenedService) => ("tag" in which ? o.tag === which.tag : o.profile === which.profile);
  for (const opened of openedServices().filter(matches)) {
    if (!(await clearOrigin(serviceOrigin(host, opened.label)))) continue;
    save(openedServices().filter((o) => o.label !== opened.label));
  }
}
