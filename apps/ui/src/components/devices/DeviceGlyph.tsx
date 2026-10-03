import type { ReactNode } from "react";

/** The kinds of device a row can show. */
export type DeviceLook = "phone" | "tablet" | "computer" | "browser";

/**
 * What a device looks like, read from its name: the device set keeps a name for each device and no kind, so the name
 * the app suggested ("iPhone", "Chrome on Mac", "Mac app") or the person typed is all there is. Only a picture: the
 * name beside it says what the device is.
 */
export function deviceLook(name: string): DeviceLook {
  if (/chrome|firefox|safari|edge|brave|opera|browser|extension/i.test(name)) return "browser";
  if (/ipad|tablet/i.test(name)) return "tablet";
  if (/phone|android|pixel|galaxy|mobile/i.test(name)) return "phone";
  return "computer";
}

const PATHS: Record<DeviceLook, ReactNode> = {
  phone: <><rect x="7" y="2.5" width="10" height="19" rx="2" /><path d="M11 18.5h2" /></>,
  tablet: <><rect x="4.5" y="2.5" width="15" height="19" rx="2" /><path d="M11 18.5h2" /></>,
  computer: <><rect x="3.5" y="4.5" width="17" height="11" rx="1.5" /><path d="M2 19.5h20" /></>,
  browser: <><rect x="2.5" y="4" width="19" height="16" rx="2" /><path d="M2.5 8.5h19M6 6.25h.01M8.5 6.25h.01" /></>,
};

/** The round mark at the start of a device's row: its kind, in the accent color when it is the active device. */
export function DeviceGlyph({ name, active }: { name: string; active?: boolean }) {
  const look = deviceLook(name);
  return (
    <span data-look={look} aria-hidden="true"
      className={`grid h-9 w-9 place-items-center rounded-full ${active ? "bg-accent/15 text-accent" : "bg-surface-alt text-text-secondary"}`}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{PATHS[look]}</svg>
    </span>
  );
}
