"use client";

import { useEffect, useRef, useState } from "react";
import { useCalm } from "@/lib/useCalm";
import { Ghost, GhostMark, type GhostMood } from "@/components/ghost/Ghost";
import { Icon } from "@/components/site/icons";
import { Particles } from "@/components/site/Particles";
import { DOWNLOADS, RELEASE_URL, VERSION, defaultInstaller, type InstallerKey } from "@/lib/release";
import { NEXT_VERSION } from "@/lib/status";
import { APP_URL } from "@/content/shell";
import type { HomeCopy } from "@/content/home";
import "@/app/finale.css";

/* Timing of the one-shot sequence, in milliseconds. */
const GLIDE = 900; // the two ghosts arrive from the edges
const LINE = 1600; // one spoken line
const SURPRISE = 300; // Boo's reaction to the 21 sats
const POOF_AFTER = 600; // Casper's "*poof*" is read before he goes
const DONE_AFTER = 900; // then Boo turns to the reader

const SATS_LINE = 5; // "Here, 21 sats ⚡"
const POOF_LINE = 7; // "*poof* 👻"

type State = "idle" | "play" | "done";

const INSTALLERS: { key: InstallerKey | "windowsMsi"; label: string }[] = [
  { key: "macArm", label: "macOS · Apple silicon" },
  { key: "macIntel", label: "macOS · Intel" },
  { key: "windowsExe", label: "Windows · .exe" },
  { key: "windowsMsi", label: "Windows · .msi" },
  { key: "linuxDeb", label: "Linux · .deb" },
  { key: "linuxAppImage", label: "Linux · AppImage" },
];

/** A heading whose words rise into view one by one; screen readers get the plain sentence. */
function Words({ text, className = "", from = 0 }: { text: string; className?: string; from?: number }) {
  return (
    <>
      {text.split(" ").map((w, i) => (
        <span key={i}>
          <span className="fin-word">
            <span className={`fin-word-in ${className}`} style={{ ["--i" as string]: from + i }}>
              {w}
            </span>
          </span>{" "}
        </span>
      ))}
    </>
  );
}

/**
 * The ending of the story. Boo and Casper meet, talk, and Casper leaves; Boo
 * turns to you and the title lands. Without scripts, or with reduced motion,
 * the final frame is simply there.
 */
export function Finale({ t }: { t: HomeCopy["finale"] }) {
  const reduce = useCalm();
  const stageRef = useRef<HTMLDivElement>(null);
  const played = useRef(false);
  const [state, setState] = useState<State>("idle");
  const [step, setStep] = useState(-1);
  const [surprised, setSurprised] = useState(false);
  const [poof, setPoof] = useState(false);
  const [installer, setInstaller] = useState<InstallerKey | undefined>(undefined);
  const [detected, setDetected] = useState(false);

  // The installer for this machine. Chrome on a Mac says whether it is Apple silicon.
  useEffect(() => {
    const nav = navigator as Navigator & {
      userAgentData?: { getHighEntropyValues(hints: string[]): Promise<{ architecture?: string }> };
    };
    let cancelled = false;
    const guess = defaultInstaller(nav.userAgent, nav.platform);
    setInstaller(guess);
    setDetected(true);
    if (guess === "macArm" && nav.userAgentData) {
      nav.userAgentData
        .getHighEntropyValues(["architecture"])
        .then((v) => {
          if (!cancelled) setInstaller(defaultInstaller(nav.userAgent, nav.platform, v.architecture));
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, []);

  // Arm the sequence when half of the stage is on screen; re-arm once the reader is a viewport away.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    if (reduce) {
      setState("done");
      return;
    }
    const start = new IntersectionObserver(
      ([e]) => {
        if (e.intersectionRatio >= 0.5 && !played.current) {
          played.current = true;
          setState("play");
        }
      },
      { threshold: [0.5] },
    );
    const far = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting && played.current) {
          played.current = false;
          setState("idle");
          setStep(-1);
          setPoof(false);
          setSurprised(false);
        }
      },
      { rootMargin: "100% 0px 100% 0px" },
    );
    start.observe(el);
    far.observe(el);
    return () => {
      start.disconnect();
      far.disconnect();
    };
  }, [reduce]);

  // The script: eight lines, one reaction, one exit.
  useEffect(() => {
    if (state !== "play") return;
    const timers: number[] = [];
    const at = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, ms));
    const lines = t.conversation.length;
    for (let i = 0; i < lines; i++) at(GLIDE + i * LINE, () => setStep(i));
    at(GLIDE + SATS_LINE * LINE, () => setSurprised(true));
    at(GLIDE + SATS_LINE * LINE + SURPRISE, () => setSurprised(false));
    at(GLIDE + POOF_LINE * LINE + POOF_AFTER, () => setPoof(true));
    at(GLIDE + POOF_LINE * LINE + DONE_AFTER, () => setState("done"));
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, [state, t.conversation.length]);

  const talking = state === "play" && step >= 0 ? t.conversation[step] : undefined;
  const lastLine = (who: string) => {
    for (let i = step; i >= 0; i--) if (t.conversation[i].side === who) return t.conversation[i].text;
    return "";
  };
  // Boo starts 120px from Casper and closes to 40px over the eight lines (the base gap is 40px).
  const closeness = step < 0 ? 0 : step / Math.max(1, t.conversation.length - 1);
  const k = state === "play" ? -0.25 + 0.25 * closeness : 0;
  const finished = state === "done";

  const booMood: GhostMood = finished
    ? poof
      ? "wink"
      : "happy"
    : surprised
      ? "surprised"
      : talking?.side === "boo"
        ? "talk"
        : "happy";
  const casperMood: GhostMood = talking?.side === "casper" ? "talk" : "happy";
  const booLook = state === "play" ? { x: 0.8, y: 0.1 } : { x: 0, y: 0.2 };
  const casperLook = state === "play" ? { x: -0.8, y: 0.1 } : { x: -0.6, y: 0.15 };

  const primary = installer ? INSTALLERS.find((d) => d.key === installer) : undefined;
  const speaker = (side: string) => (side === "boo" ? "Boo" : "Casper");

  return (
    <section className="section fin" id="download" data-state={state} data-step={step} data-poof={poof}>
      <Particles count={18} tone="mix" />
      <div className="wrap fin-inner">
        <span className="eyebrow fin-eyebrow">{t.eyebrow}</span>

        <div className="fin-stage" ref={stageRef}>
          <div className="fin-actors" aria-hidden="true">
            <div className="fin-actor fin-actor--boo" style={{ ["--k" as string]: k }}>
              <div className="fin-bubble fin-bubble--boo" data-on={talking?.side === "boo"}>
                {lastLine("boo")}
              </div>
              <div className="fin-body">
                <Ghost who="boo" size={150} mood={booMood} look={booLook} />
              </div>
            </div>
            <div className="fin-actor fin-actor--casper" style={{ ["--k" as string]: -k }}>
              <div className="fin-bubble fin-bubble--casper" data-on={talking?.side === "casper"}>
                {lastLine("casper")}
              </div>
              <div className="fin-body">
                <Ghost who="casper" size={150} mood={casperMood} look={casperLook} phase={1} />
              </div>
              {/* Siblings of the body, so they keep rising while it shrinks to nothing. */}
              {[0, 1, 2].map((i) => (
                <span key={i} className="fin-poof" style={{ ["--n" as string]: i }}>
                  <GhostMark />
                </span>
              ))}
            </div>
          </div>
          <ul className="sr-only">
            {t.conversation.map((line, i) => (
              <li key={i}>
                {speaker(line.side)}: {line.text}
              </li>
            ))}
          </ul>
        </div>

        <h2 className="h-display fin-title">
          <span className="sr-only">
            {t.title1} {t.title2}
          </span>
          <span aria-hidden="true" className="fin-title-line">
            <Words text={t.title1} />
          </span>
          <span aria-hidden="true" className="fin-title-line">
            <Words text={t.title2} className="text-gradient-animated" from={t.title1.split(" ").length} />
          </span>
        </h2>
        <p className="lead fin-lead">{t.lead}</p>

        <a className="btn btn--primary btn--lg fin-cta" href={APP_URL}>
          <GhostMark /> {t.browser.cta} <span aria-hidden="true">↗</span>
        </a>

        <div className="fin-strip">
          <div className="fin-desktop">
            <span className="caption fin-strip-label">
              {t.desktop.title} <span className="chip">v{VERSION}</span>
            </span>
            <div className="fin-desktop-row">
              {primary && (
                <a className="btn fin-installer" href={DOWNLOADS[primary.key]}>
                  <Icon name="download" /> {primary.label}
                </a>
              )}
              {/* Open on the server and without scripts; the list waits for the detection so it never flashes. */}
              <details className="fin-details" open={primary ? undefined : true} data-detected={detected || undefined}>
                <summary>
                  {t.otherPlatforms} <span aria-hidden="true" className="fin-details-mark" />
                </summary>
                <ul className="fin-platforms">
                  {INSTALLERS.map((d) => (
                    <li key={d.key}>
                      <a href={DOWNLOADS[d.key]} aria-current={d.key === installer ? "true" : undefined}>
                        <Icon name="download" /> {d.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </details>
            </div>
          </div>
          <a className="link-arrow fin-more" href={DOWNLOADS.extensionZip}>
            <Icon name="download" /> {t.extension.title} · .zip
          </a>
          <a className="link-arrow fin-more" href="/cli">
            {t.cli.cta} <span aria-hidden="true">→</span>
          </a>
        </div>
        <p className="caption fin-note">
          {t.note.replace("{v}", VERSION).replace("{n}", NEXT_VERSION)}{" "}
          <a href={RELEASE_URL}>
            {t.all} <span aria-hidden="true">↗</span>
          </a>
        </p>
      </div>
    </section>
  );
}
