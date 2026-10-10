import Link from "next/link";
import { Shell } from "@/components/site/Shell";
import { APP_URL, SUBMIT_URL, apps as t } from "@/content/apps";
import { appFingerprint } from "@/lib/store-core/appStatements";
import type { StoreView } from "@/lib/storeRead";
import { AppIcon } from "./AppIcon";
import "@/app/apps.css";

export const formatDate = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });

/** /apps: what Apps are, then every app the store lists and the site could verify, as the build read it at `readAt`. */
export function AppsPage({ store, readAt }: { store: StoreView; readAt: number }) {
  return (
    <Shell>
      <section className="ap-hero">
        <div className="wrap ap-hero-copy">
          <span className="eyebrow">{t.hero.eyebrow}</span>
          <h1 className="h-display ap-title">{t.hero.title}</h1>
          <p className="lead">{t.hero.lead}</p>
          <div className="ap-actions">
            <a className="btn btn--primary" href={APP_URL}>
              {t.hero.open}
            </a>
            <a className="btn" href={SUBMIT_URL}>
              {t.hero.submit} ↗
            </a>
          </div>
          <p className="note">{t.where}</p>
        </div>
      </section>

      <section className="wrap ap-block" aria-labelledby="ap-list">
        <div className="ap-list-head">
          <h2 id="ap-list" className="h-card">
            {t.list.title}
          </h2>
          {store.ok && <span className="ap-count mono">{t.list.count(store.apps.length)}</span>}
        </div>
        {!store.ok ? (
          <p className="note">{t.list.unavailable}</p>
        ) : (
          <>
            {store.expired && <p className="note ap-stale">{t.list.stale(formatDate(readAt), formatDate(store.expires))}</p>}
            {store.apps.length === 0 ? (
              <p className="note">{t.list.empty}</p>
            ) : (
              <ul className="ap-grid">
                {store.apps.map((app) => (
                  <li key={app.slug}>
                    <Link className="ap-card" href={`/apps/${app.slug}`}>
                      <AppIcon app={app} size={56} />
                      <span className="ap-card-text">
                        <span className="ap-card-title">{app.title}</span>
                        <span className="ap-card-tagline">{app.tagline}</span>
                        <span className="ap-card-meta mono">{[app.category, app.developer].filter(Boolean).join(" · ")}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            <p className="note ap-store">
              {store.name}. {t.list.signed} <span className="mono">{appFingerprint(store.key)}</span>.
            </p>
          </>
        )}
      </section>
    </Shell>
  );
}
