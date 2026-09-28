import Link from "next/link";
import { Shell } from "@/components/site/Shell";
import { LevelBadge } from "@/components/site/Level";
import { Reveal } from "@/components/home/Reveal";
import { agents, scope, LINKS, SESSION, STEPS, TURN } from "@/content/agents";
import "@/app/cli.css";

/** /developers/agents: the /cli page's layout (cli.css), for an AI agent on the CLI. */
export function AgentsPage() {
  const t = agents;
  return (
    <Shell>
      <section className="cl-hero">
        <div className="wrap cl-hero-grid">
          <div className="cl-hero-copy">
            <span className="eyebrow">{t.hero.eyebrow}</span>
            <h1 className="h-display cl-title">{t.hero.title}</h1>
            <p className="lead">{t.hero.lead}</p>
            <div className="cl-actions">
              <a className="btn btn--primary" href={LINKS.skill}>
                {t.hero.skill} ↗
              </a>
              <Link className="btn" href="/cli">
                {t.hero.cli}
              </Link>
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

      <section className="wrap cl-block" aria-labelledby="ag-steps">
        <h2 id="ag-steps" className="h-card">
          {t.steps.title}
        </h2>
        <ol className="cl-cmds">
          {STEPS.map((s) => (
            <Reveal as="li" key={s.cmd} className="cl-cmd">
              <code className="mono">{s.cmd}</code>
              <p className="muted">{s.hint}</p>
            </Reveal>
          ))}
        </ol>
      </section>

      <section className="wrap cl-block" aria-labelledby="ag-turn">
        <h2 id="ag-turn" className="h-card">
          {t.turn.title}
        </h2>
        <p className="muted">{t.turn.lead}</p>
        <pre className="cl-code" tabIndex={0}>
          <code>{TURN}</code>
        </pre>
        <p className="cl-more">
          <a className="link-arrow" href={LINKS.turns}>
            {t.turn.link} ↗
          </a>
        </p>
      </section>

      <section className="wrap cl-block" aria-labelledby="ag-safety">
        <h2 id="ag-safety" className="h-card">
          {t.safety.title}
        </h2>
        <p className="muted">{t.safety.body}</p>
      </section>

      <section className="wrap cl-block" aria-labelledby="ag-scope">
        <h2 id="ag-scope" className="h-card">
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

      <section className="wrap cl-block" aria-labelledby="ag-links">
        <h2 id="ag-links" className="h-card">
          {t.links.title}
        </h2>
        <ul className="cl-links">
          <li>
            <a className="link-arrow" href={LINKS.skill}>
              {t.links.skill} ↗
            </a>
          </li>
          <li>
            <a className="link-arrow" href={LINKS.guide}>
              {t.links.guide} ↗
            </a>
          </li>
          <li>
            <a className="link-arrow" href={LINKS.claude}>
              {t.links.claude} ↗
            </a>
          </li>
          <li>
            <Link className="link-arrow" href="/cli">
              {t.links.cli} →
            </Link>
          </li>
          <li>
            <Link className="link-arrow" href="/developers/wisps/11xx-headless">
              {t.links.wisp} →
            </Link>
          </li>
        </ul>
      </section>
    </Shell>
  );
}
