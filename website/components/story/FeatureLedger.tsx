import Image from "next/image";
import { features } from "../../lib/landing-features";
import { Icon } from "../icons";

export function FeatureLedger() {
  return (
    <section
      id="details"
      className="feature-ledger landing-wrap"
      aria-labelledby="ledger-heading"
    >
      <div className="ledger-heading">
        <p className="chapter-eyebrow">THE POSSIBILITIES, IN FULL</p>
        <h2 id="ledger-heading">
          The little details.
          <br />
          <em>All in one place.</em>
        </h2>
        <p>Take a closer look at what travels between your devices.</p>
      </div>
      <div className="ledger-rows">
        {features.map((feature, index) => (
          <details key={feature.id} className="ledger-row">
            <summary>
              <span className="ledger-number">0{index + 1}</span>
              <Icon name={feature.icon} />
              <span>{feature.label}</span>
              <span className="ledger-plus">+</span>
            </summary>
            <div className="ledger-content">
              <p>{feature.description}</p>
              <ul>
                {feature.details.map((detail) => (
                  <li key={detail}>{detail}</li>
                ))}
              </ul>
              <p className="ledger-note">{feature.note}</p>
              <a
                href={feature.href}
                className="story-text-link"
                {...(feature.href.startsWith("https:")
                  ? { target: "_blank", rel: "noopener noreferrer" }
                  : {})}
              >
                {feature.cta} ↗
              </a>
            </div>
          </details>
        ))}
      </div>
      <div className="ledger-extras">
        <span>And the little things.</span>
        <p>
          Custom nicknames · Light & dark themes · 8 languages · App lock · QR
          invites
        </p>
      </div>
      <details className="ledger-app">
        <summary>
          <span>Meet the actual app.</span>
          <span>Take a peek ↗</span>
        </summary>
        <figure>
          <Image
            src="/screenshots/app-chat-conversation.png"
            alt="Ghostly’s real conversation interface, with messages, file sharing, sats and shared apps."
            width={2048}
            height={1642}
            sizes="(max-width: 760px) 90vw, 900px"
          />
          <figcaption>
            The scenes above tell the story. This is the app you’ll use.
          </figcaption>
        </figure>
      </details>
    </section>
  );
}
