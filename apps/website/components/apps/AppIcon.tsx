import type { StoreApp } from "@/lib/storeRead";

/**
 * An app's icon: its bundle's icon.png, served by this site (app/apps/[slug]/app-icon), or its first letter on a tile
 * when the bundle has none. Decorative: the app's title is always next to it.
 */
export function AppIcon({ app, size }: { app: StoreApp; size: number }) {
  if (app.icon) {
    // eslint-disable-next-line @next/next/no-img-element -- verified bytes from this site, already the size they are drawn at
    return <img className="ap-icon" src={`/apps/${app.slug}/app-icon?v=${app.digest.slice(0, 12)}`} width={size} height={size} alt="" />;
  }
  return (
    <span className="ap-icon ap-icon--letter" style={{ width: size, height: size, fontSize: size * 0.46 }} aria-hidden="true">
      {[...app.title][0]?.toUpperCase()}
    </span>
  );
}
