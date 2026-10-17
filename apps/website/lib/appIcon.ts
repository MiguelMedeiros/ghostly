/*
 * The sizes an app's icon is served at (app/apps/[slug]/app-icon): each size a page draws it at (components/apps), for
 * screens of 1, 2 and 3 device pixels per CSS pixel. A publisher's icon.png may be 1024 px and 256 KiB (the bundle's
 * limits); a card draws 56 px of it.
 */

/** The CSS sizes the pages draw an icon at: a card on /apps, the head of an app's page. */
export const ICON_DRAWN = { card: 56, page: 96 } as const;
const DENSITIES = [1, 2, 3] as const;

/** Every edge the route serves, in pixels: nothing else, so a request cannot have the server make any other. */
export const ICON_EDGES: readonly number[] = Object.values(ICON_DRAWN).flatMap((size) => DENSITIES.map((d) => size * d));

const iconUrl = (slug: string, digest: string, edge: number) => `/apps/${slug}/app-icon?v=${digest.slice(0, 12)}&s=${edge}`;

/** `src` and `srcSet` for an icon drawn at `size` CSS pixels: a browser fetches only the edge its screen needs. */
export function iconSources(app: { slug: string; digest: string }, size: number): { src: string; srcSet: string } {
  return {
    src: iconUrl(app.slug, app.digest, size * 2),
    srcSet: DENSITIES.map((d) => `${iconUrl(app.slug, app.digest, size * d)} ${d}x`).join(", "),
  };
}
