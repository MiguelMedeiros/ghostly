import Link from "next/link";
import { Shell } from "@/components/site/Shell";
import { LevelBadge } from "@/components/site/Level";
import { Reveal } from "@/components/home/Reveal";
import { CopyButton } from "@/components/cli/CopyButton";
import { NEXT_VERSION } from "@/lib/status";
import { CopyPrompt, CopyPromptButton } from "./CopyPrompt";
import { AgentDemo } from "./AgentDemo";
import { AgentSteps } from "./AgentSteps";
import { Cmd } from "./Cmd";
import { agents, scope, CONNECT, LINKS, PROMPT, SHOWS, STEPS, TURN } from "@/content/agents";
import "@/app/cli.css";
import "@/app/agents.css";

/** The app's screens (npm run capture, scripts/capture/agents.spec.ts): 1280 × 820 and 390 × 844, shot at 2×. */
const SHOT = { src: "/screenshots/current/agents.webp", width: 1280, height: 820 };
const PHONE = { src: "/screenshots/current/agents-mobile.webp", width: 390, height: 844 };

/**
 * /developers/agents: a bot at work in a chat (AgentDemo) beside one button that copies the prompt; then the real app
 * with what a bot can show, three steps to connect one by hand, the prompt itself, and how it works (AgentSteps, with
 * the detail folded under it in the /cli page's layout, cli.css).
 */
export function AgentsPage() {
  const t = agents;
  return (
    <Shell>
      <section className="cl-hero ag-hero">
        <div className="wrap ag-hero-grid">
          <div className="ag-hero-copy">
            <span className="eyebrow">{t.hero.eyebrow}</span>
            <h1 className="h-display ag-title">{t.hero.title}</h1>
            <p className="lead">{t.hero.lead}</p>
            <div className="cl-actions ag-actions">
              <CopyPromptButton text={PROMPT} copy={t.hero.copy} copied={t.hero.copied} />
              <a className="link-arrow" href="#connect">
                {t.hero.connect} ↓
              </a>
            </div>
            <p className="muted ag-note">{t.hero.hint}</p>
          </div>
          <AgentDemo t={t.demo} />
        </div>
      </section>

      <section className="wrap cl-block ag-section" id="show" aria-labelledby="ag-show">
        <span className="eyebrow">{t.show.eyebrow}</span>
        <h2 id="ag-show" className="ag-h2">
          {t.show.title}
        </h2>
        <p className="muted ag-lead">{t.show.lead}</p>
        <figure className="ag-shots">
          <div className="ag-devices">
            <div className="ag-win">
              <div className="ag-win-bar" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="ag-shot" src={SHOT.src} alt={t.show.shotAlt} loading="lazy" decoding="async" width={SHOT.width} height={SHOT.height} />
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="ag-phone" src={PHONE.src} alt="" aria-hidden="true" loading="lazy" decoding="async" width={PHONE.width} height={PHONE.height} />
          </div>
          <figcaption className="caption">{t.show.caption.replace("{n}", NEXT_VERSION)}</figcaption>
        </figure>
        <ul className="ag-shows">
          {SHOWS.map((s) => (
            <Reveal as="li" key={s.id} className="ag-show">
              <h3 className="ag-h3">{s.title}</h3>
              <p className="muted">{s.body}</p>
              <code className="mono">
                <Cmd text={s.cmd} />
              </code>
            </Reveal>
          ))}
        </ul>
      </section>

      <section className="wrap cl-block ag-section" id="connect" aria-labelledby="ag-connect">
        <span className="eyebrow">{t.connect.eyebrow}</span>
        <h2 id="ag-connect" className="ag-h2">
          {t.connect.title}
        </h2>
        <p className="muted ag-lead">
          {t.connect.lead}{" "}
          <a className="link-arrow" href="#prompt">
            {t.connect.toPrompt} ↓
          </a>
        </p>
        <ol className="ag-connect" data-testid="agent-connect">
          {CONNECT.map((step, i) => (
            <li key={step.title} className="ag-step">
              <span className="ag-step-n" aria-hidden="true">
                {i + 1}
              </span>
              <div className="ag-step-body">
                <h3 className="ag-h3">{step.title}</h3>
                <p className="muted">{step.body}</p>
                {step.cmds.map((cmd) => (
                  <div key={cmd} className="cl-line">
                    <pre>
                      <code>
                        <Cmd text={cmd} />
                      </code>
                    </pre>
                    <CopyButton text={cmd} label={t.connect.copy} done={t.connect.copied} />
                  </div>
                ))}
              </div>
            </li>
          ))}
        </ol>
        <p className="note muted ag-version">
          {t.connect.note.replace("{n}", NEXT_VERSION)}{" "}
          <Link className="link-arrow" href={LINKS.cards}>
            {t.connect.cards} →
          </Link>{" "}
          <Link className="link-arrow" href={LINKS.buttons}>
            {t.connect.buttons} →
          </Link>
        </p>
      </section>

      <section className="wrap cl-block ag-section" id="prompt" aria-labelledby="ag-prompt">
        <span className="eyebrow">{t.prompt.eyebrow}</span>
        <h2 id="ag-prompt" className="ag-h2">
          {t.prompt.title}
        </h2>
        <p className="muted ag-lead">{t.prompt.lead}</p>
        <CopyPrompt text={PROMPT} label={t.prompt.label} copy={t.prompt.copy} copied={t.prompt.copied} />
        <p className="muted ag-note">{t.prompt.note}</p>
      </section>

      <section className="wrap cl-block ag-how" aria-labelledby="ag-how">
        <h2 id="ag-how" className="ag-h2">
          {t.how.title}
        </h2>
        <p className="muted">{t.how.lead}</p>
        <AgentSteps t={t.how.anim} />
      </section>

      <details className="wrap ag-details" data-testid="agent-details">
        <summary className="ag-summary">{t.how.details}</summary>
        <section className="cl-block ag-sub" aria-labelledby="ag-steps">
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

        <section className="cl-block ag-sub" aria-labelledby="ag-turn">
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

        <section className="cl-block ag-sub" aria-labelledby="ag-safety">
          <h3 id="ag-safety" className="ag-h3">
            {t.safety.title}
          </h3>
          <p className="muted">{t.safety.body}</p>
        </section>

        <section className="cl-block ag-sub" aria-labelledby="ag-scope">
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
      </details>

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
            <Link className="link-arrow" href={LINKS.cards}>
              {t.links.cards} →
            </Link>
          </li>
          <li>
            <Link className="link-arrow" href={LINKS.buttons}>
              {t.links.buttons} →
            </Link>
          </li>
          <li>
            <a className="link-arrow" href={LINKS.cliGuide}>
              {t.links.cliGuide} ↗
            </a>
          </li>
          <li>
            <a className="link-arrow" href={LINKS.readme}>
              {t.links.readme} ↗
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
            <Link className="link-arrow" href="/wisps/1100-headless">
              {t.links.wisp} →
            </Link>
          </li>
        </ul>
      </section>
    </Shell>
  );
}
