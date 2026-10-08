import Link from "next/link";
import { Shell } from "@/components/site/Shell";
import { APP_URL, CLIENTS, NO_INTERNET, PERMISSIONS, VIEWS, apps } from "@/content/apps";
import type { StoreApp } from "@/lib/storeRead";
import { AppIcon } from "./AppIcon";
import "@/app/apps.css";

const ExternalLink = ({ href }: { href: string }) => (
  <a className="link-arrow ap-url" href={href} rel="noopener noreferrer nofollow">
    {href.replace(/^https:\/\//, "")} ↗
  </a>
);

/** /apps/<slug>: one app of the store, as the build verified it, and how to install it in Ghostly. */
export function AppPage({ app, store }: { app: StoreApp; store: string }) {
  const t = apps.app;
  // The internet last, as the install screen puts it: the line that says who can learn about the person.
  const permissions = [PERMISSIONS.storage, ...(["chat", "name", "internet"] as const).filter((p) => app.permissions.includes(p)).map((p) => PERMISSIONS[p])];
  const meta = [
    app.developer && { label: t.by, value: app.developer },
    { label: t.version, value: app.version },
    app.category && { label: t.category, value: app.category },
  ].filter((m): m is { label: string; value: string } => Boolean(m));
  const source = app.homepage ?? app.repo;

  return (
    <Shell>
      <section className="ap-hero ap-hero--app">
        <div className="wrap">
          <Link className="link-arrow ap-back" href="/apps">
            ← {t.back}
          </Link>
          <div className="ap-head">
            <AppIcon app={app} size={96} />
            <div className="ap-head-copy">
              <h1 className="h-section ap-app-title">{app.title}</h1>
              <p className="lead">{app.tagline}</p>
              <dl className="ap-meta">
                {meta.map((m) => (
                  <div key={m.label}>
                    <dt>{m.label}</dt>
                    <dd>{m.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </div>
      </section>

      <div className="wrap ap-body">
        <div className="ap-main">
          {app.description && (
            <section className="ap-block ap-description">
              {app.description.split(/\n+/).map((line, i) => (
                <p key={i}>{line}</p>
              ))}
            </section>
          )}

          <section className="ap-block" aria-labelledby="ap-can">
            <h2 id="ap-can" className="h-card">
              {t.can}
            </h2>
            <ul className="ap-perms">
              {permissions.map((p) => (
                <li key={p.label}>
                  <span>{p.label}</span>
                  {p.info && <span className="note">{p.info}</span>}
                </li>
              ))}
            </ul>
            {!app.permissions.includes("internet") && <p className="note">{NO_INTERNET}</p>}
          </section>

          <section className="ap-block" aria-labelledby="ap-runs">
            <h2 id="ap-runs" className="h-card">
              {t.runs}
            </h2>
            <p className="muted">{VIEWS[app.view]}</p>
            <p className="note">
              {t.madeFor}: {app.clients.map((c) => (CLIENTS as Record<string, string>)[c] ?? c).join(", ")}. {apps.where}
            </p>
          </section>

          <section className="ap-block" aria-labelledby="ap-install">
            <h2 id="ap-install" className="h-card">
              {t.install.title}
            </h2>
            <ol className="ap-steps">
              {t.install.steps(app.title, app.fingerprint).map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <p className="ap-actions">
              <a className="btn btn--primary" href={APP_URL}>
                {t.install.open}
              </a>
            </p>
            <p className="note">{t.install.link}</p>
            <pre className="ap-code" tabIndex={0}>
              <code>{app.url}</code>
            </pre>
          </section>
        </div>

        <aside className="ap-side">
          <section className="ap-block" aria-labelledby="ap-publisher">
            <h2 id="ap-publisher" className="h-card">
              {t.publisher.title}
            </h2>
            <p className="note">{t.publisher.lead}</p>
            <dl className="ap-facts">
              <div>
                <dt>{t.publisher.key}</dt>
                <dd>
                  <span className="ap-fingerprint mono">{app.fingerprint}</span>
                  <code className="ap-key">{app.publisher}</code>
                </dd>
              </div>
              <div>
                <dt>{t.publisher.digest}</dt>
                <dd>
                  <code className="ap-key">{app.digest}</code>
                </dd>
              </div>
            </dl>
          </section>

          <section className="ap-block" aria-labelledby="ap-details">
            <h2 id="ap-details" className="h-card">
              {t.details}
            </h2>
            <dl className="ap-facts">
              <div>
                <dt>{t.license}</dt>
                <dd>{app.license}</dd>
              </div>
              {source && (
                <div>
                  <dt>{t.source}</dt>
                  <dd>
                    <ExternalLink href={source} />
                  </dd>
                </div>
              )}
              {app.support && (
                <div>
                  <dt>{t.support}</dt>
                  <dd>
                    <ExternalLink href={app.support} />
                  </dd>
                </div>
              )}
              {app.releaseNotes && (
                <div>
                  <dt>{t.notes}</dt>
                  <dd>{app.releaseNotes}</dd>
                </div>
              )}
            </dl>
            <p className="note">{t.listed(store)}</p>
          </section>
        </aside>
      </div>
    </Shell>
  );
}
