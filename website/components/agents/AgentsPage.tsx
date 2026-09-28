import Link from "next/link";
import { Shell } from "@/components/site/Shell";
import { LevelBadge } from "@/components/site/Level";
import { Reveal } from "@/components/home/Reveal";
import { CopyPrompt } from "./CopyPrompt";
import { agents, scope, LINKS, PROMPT, STEPS, TURN } from "@/content/agents";
import "@/app/cli.css";
import "@/app/agents.css";

/**
 * /developers/agents: one prompt to copy into a coding agent at the top, then how it works (the /cli page's
 * layout, cli.css) for whoever wants the detail.
 */
export function AgentsPage() {
  const t = agents;
  return (
    <Shell>
      <section className="cl-hero ag-hero">
        <div className="wrap ag-hero-inner">
          <span className="eyebrow">{t.hero.eyebrow}</span>
          <h1 className="h-display ag-title">{t.hero.title}</h1>
          <p className="lead">{t.hero.lead}</p>
          <CopyPrompt text={PROMPT} label={t.hero.label} copy={t.hero.copy} copied={t.hero.copied} />
          <p className="muted ag-note">{t.hero.note}</p>
        </div>
      </section>

      <section className="wrap cl-block ag-how" aria-labelledby="ag-how">
        <h2 id="ag-how" className="h-card">
          {t.how.title}
        </h2>
        <p className="muted">{t.how.lead}</p>
      </section>

      <section className="wrap cl-block ag-sub" aria-labelledby="ag-steps">
        <h3 id="ag-steps" className="ag-h3">
          {t.steps.title}
        </h3>
        <ol className="cl-cmds">
          {STEPS.map((s) => (
            <Reveal as="li" key={s.cmd} className="cl-cmd">
              <code className="mono">{s.cmd}</code>
              <p className="muted">{s.hint}</p>
            </Reveal>
          ))}
        </ol>
      </section>

      <section className="wrap cl-block ag-sub" aria-labelledby="ag-turn">
        <h3 id="ag-turn" className="ag-h3">
          {t.turn.title}
        </h3>
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

      <section className="wrap cl-block ag-sub" aria-labelledby="ag-safety">
        <h3 id="ag-safety" className="ag-h3">
          {t.safety.title}
        </h3>
        <p className="muted">{t.safety.body}</p>
      </section>

      <section className="wrap cl-block ag-sub" aria-labelledby="ag-scope">
        <h3 id="ag-scope" className="ag-h3">
          {t.scope.title}
        </h3>
        <ul className="cl-scope">
          {scope.map((s) => (
            <li key={s.key}>
              <LevelBadge level={s.level} small />
              <span>{t.scope.items[s.key]}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="wrap cl-block ag-sub" aria-labelledby="ag-links">
        <h3 id="ag-links" className="ag-h3">
          {t.links.title}
        </h3>
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
