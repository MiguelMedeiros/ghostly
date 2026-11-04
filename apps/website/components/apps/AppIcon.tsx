import { iconSources } from "@/lib/appIcon";
import type { StoreApp } from "@/lib/storeRead";

/**
 * An app's icon: its bundle's icon.png, served by this site at the size it is drawn (app/apps/[slug]/app-icon), or its
 * first letter on a tile when the bundle has none. Decorative: the app's title is always next to it. `lazy` for the
 * cards of /apps, of which there may be 200.
 */
export function AppIcon({ app, size, lazy = false }: { app: StoreApp; size: number; lazy?: boolean }) {
  if (app.icon) {
    const { src, srcSet } = iconSources(app, size);
    // eslint-disable-next-line @next/next/no-img-element -- verified bytes from this site, resized by its own route
    return <img className="ap-icon" src={src} srcSet={srcSet} width={size} height={size} alt="" loading={lazy ? "lazy" : undefined} decoding="async" />;
  }
  return (
    <span className="ap-icon ap-icon--letter" style={{ width: size, height: size, fontSize: size * 0.46 }} aria-hidden="true">
      {[...app.title][0]?.toUpperCase()}
    </span>
  );
}
