import Link from "next/link";
import { IntentLink } from "@/components/site/IntentLink";
import { Shell } from "@/components/site/Shell";
import { LevelBadge } from "@/components/site/Level";
import { Reveal } from "@/components/home/Reveal";
import { CopyButton } from "@/components/cli/CopyButton";
import { SHOTS_VERSION } from "@/lib/release";
import { CARDS_VERSION } from "@/lib/status";
import { shotSrcSet } from "@/lib/shots";
import { CopyPrompt, CopyPromptButton } from "./CopyPrompt";
import { AgentDemo } from "./AgentDemo";
import { AgentSteps } from "./AgentSteps";
import { Cmd } from "./Cmd";
import { agents, scope, CONNECT, LINKS, PROMPT, SECURITY, SHOWS, STEPS, TRUST, TURN } from "@/content/agents";
import "@/app/cli.css";
import "@/app/agents.css";

/**
 * The app's screens (npm run capture, scripts/capture/agents.spec.ts): 1280 × 820 and 390 × 844, shot at 2×.
 * `sizes` is the width each is drawn at (agents.css): the window takes 81% of the figure, 980px at most, and the
 * phone beside it 19%; up to 760px the phone stands alone, 70% of the page and 300px at most.
 */
const SHOT = { src: "/screenshots/current/agents.webp", width: 1280, height: 820, sizes: "min(81vw - 57px, 980px)" };
const PHONE = { src: "/screenshots/current/agents-mobile.webp", width: 390, height: 844, sizes: "(min-width: 761px) min(19vw - 9px, 234px), min(70vw - 22px, 300px)" };

/**
 * /developers/agents: a bot at work in a chat (AgentDemo) beside one button that copies the prompt; then the security
 * model (who can give the agent work, and the limit) and who it is for; the real app with what a bot can show, three
 * steps to connect one by hand, the prompt itself, and how it works (AgentSteps, with the detail folded under it in the
 * /cli page's layout, cli.css); then what a reader can check before trusting it.
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

      <section className="wrap cl-block ag-section" id="security" aria-labelledby="ag-security" data-testid="agent-security">
        <span className="eyebrow">{t.security.eyebrow}</span>
        <h2 id="ag-security" className="ag-h2">
          {t.security.title}
        </h2>
        <p className="muted ag-lead">{t.security.lead}</p>
        <ul className="ag-shows">
          {SECURITY.map((s) => (
            <li key={s.id} className="ag-show">
              <h3 className="ag-h3">{s.title}</h3>
              <p className="muted">{s.body}</p>
              <code className="mono">
                <Cmd text={s.cmd} />
              </code>
            </li>
          ))}
        </ul>
        <div className="ag-limit">
          <h3 className="ag-h3">{t.security.limitTitle}</h3>
          <p>{t.security.limit}</p>
          <p className="ag-limit-links">
            <IntentLink className="link-arrow" href={LINKS.threat}>
              {t.security.threat} →
            </IntentLink>{" "}
            <a className="link-arrow" href={LINKS.safe}>
              {t.security.more} ↗
            </a>
          </p>
        </div>
      </section>

      <section className="wrap cl-block ag-section" id="fit" aria-labelledby="ag-fit">
        <span className="eyebrow">{t.fit.eyebrow}</span>
        <h2 id="ag-fit" className="ag-h2">
          {t.fit.title}
        </h2>
        <div className="ag-fit">
          <div className="ag-show">
            <h3 className="ag-h3">{t.fit.forTitle}</h3>
            <ul className="ag-list">
              {t.fit.for.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
          <div className="ag-show">
            <h3 className="ag-h3">{t.fit.notTitle}</h3>
            <ul className="ag-list">
              {t.fit.not.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
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
              <img className="ag-shot" src={SHOT.src} srcSet={shotSrcSet(SHOT.src, "desktop")} sizes={SHOT.sizes} alt={t.show.shotAlt} loading="lazy" decoding="async" width={SHOT.width} height={SHOT.height} />
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="ag-phone" src={PHONE.src} srcSet={shotSrcSet(PHONE.src, "phone")} sizes={PHONE.sizes} alt="" aria-hidden="true" loading="lazy" decoding="async" width={PHONE.width} height={PHONE.height} />
          </div>
          <figcaption className="caption">{t.show.caption.replace("{n}", SHOTS_VERSION)}</figcaption>
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
          {t.connect.note.replace("{n}", CARDS_VERSION)}{" "}
          <IntentLink className="link-arrow" href={LINKS.cards}>
            {t.connect.cards} →
          </IntentLink>{" "}
          <IntentLink className="link-arrow" href={LINKS.buttons}>
            {t.connect.buttons} →
          </IntentLink>
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

      <section className="wrap cl-block ag-section" id="trust" aria-labelledby="ag-trust" data-testid="agent-trust">
        <span className="eyebrow">{t.trust.eyebrow}</span>
        <h2 id="ag-trust" className="ag-h2">
          {t.trust.title}
        </h2>
        <p className="muted ag-lead">{t.trust.lead}</p>
        <ul className="ag-trust">
          {TRUST.map((item) => (
            <li key={item.id}>
              <span>{item.text}</span>{" "}
              <a className="link-arrow" href={LINKS[item.link]}>
                {item.label} ↗
              </a>
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
            <IntentLink className="link-arrow" href={LINKS.threat}>
              {t.links.threat} →
            </IntentLink>
          </li>
          <li>
            <a className="link-arrow" href={LINKS.faq}>
              {t.links.faq} →
            </a>
          </li>
          <li>
            <a className="link-arrow" href={LINKS.llms}>
              {t.links.llms} →
            </a>
          </li>
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
            <IntentLink className="link-arrow" href={LINKS.cards}>
              {t.links.cards} →
            </IntentLink>
          </li>
          <li>
            <IntentLink className="link-arrow" href={LINKS.buttons}>
              {t.links.buttons} →
            </IntentLink>
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
            <IntentLink className="link-arrow" href="/wisps/1100-headless">
              {t.links.wisp} →
            </IntentLink>
          </li>
        </ul>
      </section>
    </Shell>
  );
}
