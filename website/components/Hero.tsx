"use client";

import { GhostConversation, GhostParticles } from "./GhostScene";
import { GhostGlyph, Icon } from "./icons";
import { MotionToggle } from "./HauntedPage";

export function Hero() {
  return (
    <section className="landing-hero" aria-labelledby="hero-heading">
      <div className="haunted-grid" aria-hidden="true" />
      <div className="ghost-aura cyan-aura" aria-hidden="true" />
      <div className="ghost-aura green-aura" aria-hidden="true" />
      <GhostParticles />
      <div className="landing-wrap hero-haunt">
        <div className="hero-badge">
          <GhostGlyph /> A little spooky. A lot more private.
        </div>
        <h1 id="hero-heading" aria-label="Ghostly">
          {"Ghostly".split("").map((letter, index) => (
            <span
              className="ghost-letter"
              key={index}
              aria-hidden="true"
              style={{ animationDelay: `${index * 75}ms` }}
            >
              {letter}
            </span>
          ))}
        </h1>
        <GhostConversation />
        <h2 className="hero-promise">
          Your conversations have <span>a ghost side.</span>
        </h2>
        <p className="hero-description">
          Chat, call, send files and sats — even share an app running on your
          computer. One encrypted connection. No account required.
        </p>
        <div className="hero-actions">
          <a
            className="landing-button primary"
            href="https://app.ghostly.tools"
            target="_blank"
            rel="noopener noreferrer"
          >
            <GhostGlyph /> Become a ghost <span aria-hidden="true">↗</span>
          </a>
          <a className="landing-button secondary" href="#features">
            See what ghosts can do <span aria-hidden="true">↓</span>
          </a>
        </div>
        <p className="hero-note">
          Open in your browser. Free, open source, and ready to haunt.
        </p>
        <div className="hero-small-links">
          <a className="quiet-link" href="#download">
            Desktop & extension <span aria-hidden="true">→</span>
          </a>
          <MotionToggle />
        </div>
      </div>
      <div className="landing-wrap hero-principles">
        <span>
          <Icon name="key" /> End-to-end encrypted
        </span>
        <span>
          <Icon name="chat" /> No email or phone number
        </span>
        <span>
          <Icon name="globe" /> No central Ghostly message server
        </span>
        <a
          href="https://github.com/MiguelMedeiros/ghostly"
          target="_blank"
          rel="noopener noreferrer"
        >
          Open source, by design <span aria-hidden="true">↗</span>
        </a>
      </div>
    </section>
  );
}
