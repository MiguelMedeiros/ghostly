import { IntentLink } from "@/components/site/IntentLink";
import { Ghost, GhostMark } from "@/components/ghost/Ghost";
import { Brand } from "./Brand";
import { RELEASES_URL } from "@/lib/release";
import { shell, APP_URL, CONTRIBUTING_URL, REPO_URL, SECURITY_URL } from "@/content/shell";
import { Particles } from "./Particles";

/** `apps`: whether the released Ghostly has Apps, so the Apps page exists (lib/appsGate.ts). */
export function SiteFooter({ apps = false }: { apps?: boolean }) {
  const t = shell.footer;
  const cols = [
    {
      title: t.product,
      links: [
        { label: t.links.open, href: APP_URL },
        { label: t.links.download, href: "/#download" },
        ...(apps ? [{ label: t.links.apps, href: "/apps" }] : []),
        { label: t.links.privacy, href: "/privacy" },
        { label: t.links.terms, href: "/terms" },
      ],
    },
    {
      title: t.developers,
      links: [
        { label: t.links.overview, href: "/developers" },
        { label: t.links.catalog, href: "/wisps" },
        { label: t.links.cli, href: "/cli" },
        { label: t.links.roadmap, href: "/roadmap" },
        // What an AI agent reads first (scripts/llms.mjs): a text file, so a plain link, never a prefetched page.
        { label: t.links.llms, href: "/llms.txt" },
      ],
    },
    {
      title: t.project,
      links: [
        { label: t.links.github, href: REPO_URL },
        { label: t.links.releases, href: RELEASES_URL },
        { label: t.links.security, href: SECURITY_URL },
        { label: t.links.contributing, href: CONTRIBUTING_URL },
        { label: t.links.brand, href: "/brand" },
      ],
    },
  ];
  return (
    <footer className="footer">
      <Particles count={12} tone="mix" />
      <div className="wrap">
        <div className="footer-top">
          <div>
            <IntentLink href={"/"} className="brand">
              <Brand />
            </IntentLink>
            <p className="muted" style={{ marginTop: 14, maxWidth: 340, fontSize: 14, lineHeight: 1.6 }}>
              {t.tagline}
            </p>
          </div>
          {cols.map((col) => (
            <nav key={col.title} aria-label={col.title}>
              <h2>{col.title}</h2>
              <ul>
                {col.links.map((l) => (
                  <li key={l.label}>
                    {l.href.startsWith("http") || l.href.endsWith(".txt") ? <a href={l.href}>{l.label}</a> : <IntentLink href={l.href}>{l.label}</IntentLink>}
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
        <div className="footer-bottom">
          <span className="footer-haunt">
            <GhostMark />
            <span>
              {t.haunt} <a href="https://github.com/pubky/pkarr">Pkarr</a> ·{" "}
              <a href="https://www.bittorrent.org/beps/bep_0044.html">BEP44</a>
            </span>
          </span>
          <span>
            {t.made} <a href="https://miguelmedeiros.dev">Miguel Medeiros</a>
          </span>
        </div>
      </div>
      <div className="footer-sleeper" role="img" aria-label={t.sleeping}>
        <Ghost who="boo" mood="sleep" size={56} float={false} />
        <span className="zzz" aria-hidden="true">
          <span>z</span>
          <span>z</span>
          <span>z</span>
        </span>
      </div>
    </footer>
  );
}
