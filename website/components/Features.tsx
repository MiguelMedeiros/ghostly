"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import Image from "next/image";
import { motion } from "motion/react";
import { GhostGlyph, Icon } from "./icons";
import { ProductDemo } from "./ProductDemo";
import { useHaunting } from "./HauntedPage";

import { features } from "../lib/landing-features";
export type { FeatureId } from "../lib/landing-features";

export function Features() {
  const { enabled } = useHaunting();
  const [activeIndex, setActiveIndex] = useState(4);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);

  function navigateTabs(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    let next: number;
    if (event.key === "ArrowRight") next = (index + 1) % features.length;
    else if (event.key === "ArrowLeft")
      next = (index - 1 + features.length) % features.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = features.length - 1;
    else return;
    event.preventDefault();
    setActiveIndex(next);
    tabs.current[next]?.focus();
  }

  return (
    <section
      id="features"
      className="landing-section features-section"
      aria-labelledby="features-heading"
    >
      <div className="landing-wrap">
        <div className="section-heading horizontal-heading">
          <div>
            <p className="eyebrow">A few tricks up our invisible sleeves.</p>
            <h2 id="features-heading">
              Not your average <span className="text-gradient">ghost.</span>
            </h2>
          </div>
          <p>
            From a private hello to a working prototype.
            <br />
            Choose something you’d like to do.
          </p>
        </div>
        <div
          className="feature-tabs"
          role="tablist"
          aria-label="Explore Ghostly features"
        >
          {features.map((feature, index) => (
            <button
              key={feature.id}
              ref={(element) => {
                tabs.current[index] = element;
              }}
              id={`tab-${feature.id}`}
              role="tab"
              type="button"
              aria-selected={activeIndex === index}
              aria-controls={`panel-${feature.id}`}
              tabIndex={activeIndex === index ? 0 : -1}
              onClick={() => setActiveIndex(index)}
              onKeyDown={(event) => navigateTabs(event, index)}
            >
              <Icon name={feature.icon} />
              <span>{feature.label}</span>
            </button>
          ))}
        </div>
        {features.map((feature, index) => (
          <div
            key={feature.id}
            id={`panel-${feature.id}`}
            role="tabpanel"
            aria-labelledby={`tab-${feature.id}`}
            hidden={activeIndex !== index}
            tabIndex={0}
            className="feature-panel"
          >
            <div className="feature-copy">
              <p className="eyebrow">{feature.kicker}</p>
              <h3>{feature.title}</h3>
              <p className="feature-description">{feature.description}</p>
              <ul>
                {feature.details.map((detail) => (
                  <li key={detail}>
                    <Icon name="check" />
                    {detail}
                  </li>
                ))}
              </ul>
              <a
                className="text-link"
                href={feature.href}
                {...(feature.href.startsWith("https:")
                  ? { target: "_blank", rel: "noopener noreferrer" }
                  : {})}
              >
                {feature.cta} <span aria-hidden="true">↗</span>
              </a>
              <p className="feature-note">{feature.note}</p>
            </div>
            <div className="feature-visual">
              <div className="demo-label">
                <span className="demo-dot" />
                {feature.id === "apps"
                  ? "Interactive illustration · try the switch"
                  : "Illustrated preview"}
              </div>
              {activeIndex === index && (
                <motion.div
                  className="demo-entrance"
                  initial={enabled ? { opacity: 0, y: 18, scale: 0.97 } : false}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{ duration: enabled ? 0.4 : 0, ease: "easeOut" }}
                >
                  <ProductDemo feature={feature.id} />
                </motion.div>
              )}
            </div>
          </div>
        ))}
        <div className="everyday-features">
          <span>The everyday details, too.</span>
          <p>
            Custom nicknames <span>·</span> Light & dark themes <span>·</span> 8
            languages <span>·</span> App lock <span>·</span> QR invites
          </p>
        </div>
        <details className="real-app-peek">
          <summary>
            <GhostGlyph />
            <span>Psst… here’s what the real app looks like.</span>
            <span className="peek-label">
              Peek inside <span aria-hidden="true">↓</span>
            </span>
          </summary>
          <figure>
            <Image
              src="/screenshots/app-chat-conversation.png"
              alt="The actual Ghostly interface with chat, a shared app, a received file and a sats payment."
              width={2048}
              height={1642}
              sizes="(max-width: 900px) 90vw, 900px"
            />
            <figcaption>
              One conversation, with your files, sats and shared apps right
              there.{" "}
              <a
                href="/screenshots/app-chat-conversation.png"
                target="_blank"
                rel="noopener noreferrer"
              >
                View full screenshot ↗
              </a>
            </figcaption>
          </figure>
        </details>
      </div>
    </section>
  );
}
