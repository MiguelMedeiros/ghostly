import Link from "next/link";
import { Shell } from "@/components/site/Shell";
import { LevelBadge } from "@/components/site/Level";
import { Reveal } from "@/components/home/Reveal";
import { cli, scope, COMMANDS, ECHO_BOT, INSTALL, LINKS, SESSION } from "@/content/cli";
import { CopyButton } from "./CopyButton";
import "@/app/cli.css";

export function CliPage() {
  const t = cli;
  return (
    <Shell>
      <section className="cl-hero">
        <div className="wrap cl-hero-grid">
          <div className="cl-hero-copy">
            <span className="eyebrow">{t.hero.eyebrow}</span>
            <h1 className="h-display cl-title">{t.hero.title}</h1>
            <p className="lead">{t.hero.lead}</p>
            <div className="cl-actions">
              <a className="btn btn--primary" href="#install">
                {t.hero.install}
              </a>
              <a className="btn" href={LINKS.guide}>
                {t.hero.guide} ↗
              </a>
            </div>
          </div>
          <div className="cl-win">
            <div className="cl-bar" aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
            <pre className="cl-term" aria-label={t.hero.term} tabIndex={0}>
              <code>{SESSION}</code>
            </pre>
          </div>
        </div>
      </section>

      <section className="wrap cl-block" id="install" aria-labelledby="cl-install">
        <h2 id="cl-install" className="h-card">
          {t.install.title}
        </h2>
        <div className="cl-line">
          <pre tabIndex={0}>
            <code>{INSTALL}</code>
          </pre>
          <CopyButton text={INSTALL} label={t.install.copy} done={t.install.copied} />
        </div>
        <p className="note">{t.install.hint}</p>
      </section>

      <section className="wrap cl-block" aria-labelledby="cl-commands">
        <h2 id="cl-commands" className="h-card">
          {t.commands.title}
        </h2>
        <ol className="cl-cmds">
          {COMMANDS.map((c, i) => (
            <Reveal as="li" key={c} className="cl-cmd">
              <code className="mono">{c}</code>
              <p className="muted">{t.commands.hints[i]}</p>
            </Reveal>
          ))}
        </ol>
      </section>

      <section className="wrap cl-block" aria-labelledby="cl-bot">
        <h2 id="cl-bot" className="h-card">
          {t.bot.title}
        </h2>
        <p className="muted">{t.bot.lead}</p>
        <pre className="cl-code" tabIndex={0}>
          <code>{ECHO_BOT}</code>
        </pre>
        <p className="cl-more">
          <a className="link-arrow" href={LINKS.echoBot}>
            {t.bot.echo} ↗
          </a>
          <a className="link-arrow" href={LINKS.paymentBot}>
            {t.bot.payment} ↗
          </a>
        </p>
      </section>

      <section className="wrap cl-block" aria-labelledby="cl-scope">
        <h2 id="cl-scope" className="h-card">
          {t.scope.title}
        </h2>
        <ul className="cl-scope">
          {scope.map((s) => (
            <li key={s.key}>
              <LevelBadge level={s.level} small />
              <span>{t.scope.items[s.key]}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="wrap cl-block" aria-labelledby="cl-links">
        <h2 id="cl-links" className="h-card">
          {t.links.title}
        </h2>
        <ul className="cl-links">
          <li>
            <a className="link-arrow" href={LINKS.guide}>
              {t.links.guide} ↗
            </a>
          </li>
          <li>
            <a className="link-arrow" href={LINKS.reference}>
              {t.links.reference} ↗
            </a>
          </li>
          <li>
            <Link className="link-arrow" href="/developers/agents">
              {t.links.agents} →
            </Link>
          </li>
          <li>
            <Link className="link-arrow" href="/wisps/1100-headless">
              {t.links.wisp} →
            </Link>
          </li>
        </ul>
        <aside className="cl-legacy">
          <h3>{t.legacy.title}</h3>
          <p className="note">
            {t.legacy.body}{" "}
            <a className="link-arrow" href={LINKS.legacy}>
              {t.legacy.link} ↗
            </a>
          </p>
        </aside>
      </section>
    </Shell>
  );
}
