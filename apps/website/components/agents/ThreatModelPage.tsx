import { IntentLink } from "@/components/site/IntentLink";
import { Shell } from "@/components/site/Shell";
import { Cmd } from "./Cmd";
import { threat } from "@/content/agentsThreat";
import { LINKS } from "@/content/agents";
import "@/app/cli.css";
import "@/app/agents.css";

/**
 * /developers/agents/threat-model: who can reach an agent on Ghostly, what a sender cannot make it do (each with the
 * command that sets the control), which control stops what, the limits no control removes, and what is not built yet.
 * The agents page links here from its security model.
 */
export function ThreatModelPage() {
  const t = threat;
  return (
    <Shell>
      <section className="cl-hero ag-hero">
        <div className="wrap">
          <span className="eyebrow">{t.hero.eyebrow}</span>
          <h1 className="h-display ag-title">{t.hero.title}</h1>
          <p className="lead">{t.hero.lead}</p>
          <p className="ag-note">
            <IntentLink className="link-arrow" href="/developers/agents">
              ← {t.hero.back}
            </IntentLink>
          </p>
        </div>
      </section>

      <section className="wrap cl-block ag-section" id="who" aria-labelledby="tm-who" data-testid="threat-who">
        <span className="eyebrow">{t.who.eyebrow}</span>
        <h2 id="tm-who" className="ag-h2">
          {t.who.title}
        </h2>
        <ul className="ag-shows">
          {t.who.items.map((s) => (
            <li key={s.id} className="ag-show">
              <h3 className="ag-h3">{s.title}</h3>
              <p className="muted">{s.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="wrap cl-block ag-section" id="cannot" aria-labelledby="tm-cannot" data-testid="threat-cannot">
        <span className="eyebrow">{t.cannot.eyebrow}</span>
        <h2 id="tm-cannot" className="ag-h2">
          {t.cannot.title}
        </h2>
        <ul className="ag-shows">
          {t.cannot.items.map((s) => (
            <li key={s.id} className="ag-show">
              <p>{s.text}</p>
              <code className="mono">
                <Cmd text={s.cmd} />
              </code>
            </li>
          ))}
        </ul>
      </section>

      <section className="wrap cl-block ag-section" id="controls" aria-labelledby="tm-controls" data-testid="threat-controls">
        <span className="eyebrow">{t.controls.eyebrow}</span>
        <h2 id="tm-controls" className="ag-h2">
          {t.controls.title}
        </h2>
        <ul className="ag-shows">
          {t.controls.items.map((s) => (
            <li key={s.id} className="ag-show">
              <h3 className="ag-h3">{s.title}</h3>
              <p>
                <strong>Stops:</strong> {s.stops}
              </p>
              <p className="muted">{s.how}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="wrap cl-block ag-section" id="limits" aria-labelledby="tm-limits" data-testid="threat-limits">
        <span className="eyebrow">{t.limits.eyebrow}</span>
        <h2 id="tm-limits" className="ag-h2">
          {t.limits.title}
        </h2>
        <div className="ag-limits">
          {t.limits.items.map((s) => (
            <div key={s.id} className="ag-limit">
              <h3 className="ag-h3">{s.title}</h3>
              <p>{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="wrap cl-block ag-section" id="gaps" aria-labelledby="tm-gaps" data-testid="threat-gaps">
        <span className="eyebrow">{t.gaps.eyebrow}</span>
        <h2 id="tm-gaps" className="ag-h2">
          {t.gaps.title}
        </h2>
        <p className="muted ag-lead">{t.gaps.lead}</p>
        <ul className="ag-trust">
          {t.gaps.items.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>

      <section className="wrap cl-block ag-sub" aria-labelledby="tm-more">
        <h3 id="tm-more" className="ag-h3">
          {t.more.title}
        </h3>
        <ul className="cl-links">
          <li>
            <IntentLink className="link-arrow" href="/developers/agents">
              {t.more.agents} →
            </IntentLink>
          </li>
          <li>
            <a className="link-arrow" href={LINKS.faq}>
              {t.more.faq} →
            </a>
          </li>
          <li>
            <a className="link-arrow" href={LINKS.llms}>
              {t.more.llms} →
            </a>
          </li>
          <li>
            <a className="link-arrow" href={LINKS.safe}>
              {t.more.safe} ↗
            </a>
          </li>
          <li>
            <a className="link-arrow" href={LINKS.policy}>
              {t.more.policy} ↗
            </a>
          </li>
        </ul>
      </section>
    </Shell>
  );
}
