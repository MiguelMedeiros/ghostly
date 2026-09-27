import Link from "next/link";
import { Ghost, GhostMark } from "@/components/ghost/Ghost";
import { Brand } from "./Brand";
import { href, type Locale } from "@/lib/i18n";
import { RELEASES_URL } from "@/lib/release";
import { shell, APP_URL, REPO_URL } from "@/content/shell";
import { Particles } from "./Particles";

export function SiteFooter({ locale = "en" }: { locale?: Locale }) {
  const t = shell[locale].footer;
  const cols = [
    {
      title: t.product,
      links: [
        { label: t.links.open, href: APP_URL },
        { label: t.links.download, href: href(locale, "/#download") },
        { label: t.links.privacy, href: "/privacy" },
      ],
    },
    {
      title: t.developers,
      links: [
        { label: t.links.overview, href: href(locale, "/developers") },
        { label: t.links.catalog, href: href(locale, "/developers/catalog") },
        { label: t.links.protocol, href: "/docs" },
        { label: t.links.cli, href: "/cli" },
        { label: t.links.roadmap, href: href(locale, "/roadmap") },
      ],
    },
    {
      title: t.project,
      links: [
        { label: t.links.github, href: REPO_URL },
        { label: t.links.releases, href: RELEASES_URL },
        { label: t.links.security, href: href(locale, "/developers/wisps/security") },
        { label: t.links.contributing, href: href(locale, "/developers/wisps/contributing") },
      ],
    },
  ];
  return (
    <footer className="footer">
      <Particles count={12} tone="mix" />
      <div className="wrap">
        <div className="footer-top">
          <div>
            <Link href={href(locale, "/")} className="brand">
              <Brand />
            </Link>
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
                    {l.href.startsWith("http") ? <a href={l.href}>{l.label}</a> : <Link href={l.href}>{l.label}</Link>}
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
