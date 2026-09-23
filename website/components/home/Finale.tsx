"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useCalm } from "@/lib/useCalm";
import { Ghost, GhostMark } from "@/components/ghost/Ghost";
import { Icon } from "@/components/site/icons";
import { Particles } from "@/components/site/Particles";
import { DOWNLOADS, RELEASE_URL, VERSION } from "@/lib/release";
import { NEXT_VERSION } from "@/lib/status";
import { APP_URL } from "@/content/shell";
import type { HomeCopy } from "@/content/home";

/** Boo and Casper's little conversation from the original hero, now the ending. */
function Conversation({ lines }: { lines: HomeCopy["finale"]["conversation"] }) {
  const reduce = useCalm();
  const [i, setI] = useState(0);
  useEffect(() => {
    if (reduce) return;
    const id = window.setInterval(() => setI((n) => (n + 1) % lines.length), 3200);
    return () => window.clearInterval(id);
  }, [reduce, lines.length]);
  const line = lines[i];
  return (
    <div className="finale-ghosts" aria-hidden="true">
      {(["boo", "casper"] as const).map((who, k) => (
        <div key={who} className="finale-ghost">
          <div className="finale-bubble-slot">
            <AnimatePresence mode="wait">
              {line.side === who && (
                <motion.div
                  key={i}
                  className={`bubble bubble--${who}`}
                  initial={{ opacity: 0, y: 8, scale: 0.9 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -8, scale: 0.9 }}
                  transition={{ duration: 0.3 }}
                >
                  {line.text}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <Ghost who={who} size={110} phase={k} mood={line.side === who ? "talk" : i % 4 === 3 ? "wink" : "happy"} look={{ x: k === 0 ? 0.8 : -0.8, y: 0 }} />
        </div>
      ))}
    </div>
  );
}

export function Finale({ t }: { t: HomeCopy["finale"] }) {
  const desktop = [
    { label: "macOS · Apple silicon", href: DOWNLOADS.macArm },
    { label: "macOS · Intel", href: DOWNLOADS.macIntel },
    { label: "Windows · .exe", href: DOWNLOADS.windowsExe },
    { label: "Windows · .msi", href: DOWNLOADS.windowsMsi },
    { label: "Linux · .deb", href: DOWNLOADS.linuxDeb },
    { label: "Linux · AppImage", href: DOWNLOADS.linuxAppImage },
  ];
  return (
    <section className="section finale" id="download">
      <Particles count={26} tone="mix" />
      <div className="wrap finale-inner">
        <Conversation lines={t.conversation} />
        <span className="eyebrow">{t.eyebrow}</span>
        <h2 className="h-display finale-title">
          {t.title1} <span className="text-gradient-animated">{t.title2}</span>
        </h2>
        <p className="lead">{t.lead}</p>

        <div className="dl-grid">
          <article className="card dl dl--primary">
            <Icon name="globe" />
            <h3>{t.browser.title}</h3>
            <p className="muted">{t.browser.body}</p>
            <a className="btn btn--primary" href={APP_URL}>
              <GhostMark /> {t.browser.cta}
            </a>
          </article>
          <article className="card dl">
            <Icon name="desktop" />
            <h3>
              {t.desktop.title} <span className="chip">v{VERSION}</span>
            </h3>
            <p className="muted">{t.desktop.body}</p>
            <ul className="dl-list">
              {desktop.map((d) => (
                <li key={d.label}>
                  <a href={d.href}>
                    <Icon name="download" /> {d.label}
                  </a>
                </li>
              ))}
            </ul>
          </article>
          <article className="card dl">
            <Icon name="puzzle" />
            <h3>{t.extension.title}</h3>
            <p className="muted">{t.extension.body}</p>
            <a className="btn" href={DOWNLOADS.extensionZip}>
              <Icon name="download" /> {t.extension.cta}
            </a>
            <h3 style={{ marginTop: 22 }}>{t.cli.title}</h3>
            <p className="muted">{t.cli.body}</p>
            <a className="link-arrow" href="/cli">
              {t.cli.cta} →
            </a>
          </article>
        </div>
        <p className="finale-note">
          {t.note.replace("{v}", VERSION).replace("{n}", NEXT_VERSION)}{" "}
          <a href={RELEASE_URL} className="link-arrow">
            {t.all} ↗
          </a>
        </p>
      </div>
    </section>
  );
}
