"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { Ghost } from "@/components/ghost/Ghost";
import { LevelBadge } from "@/components/site/Level";
import { NEXT_VERSION } from "@/lib/status";
import type { Locale } from "@/lib/i18n";
import type { HomeCopy } from "@/content/home";
import "@/app/next.css";

type Shot = {
  src: string;
  alt: string;
  from: "dev" | "old";
  width: number;
  height: number;
  /** The part of the picture the window shows: left edge, top edge and width, as
   *  fractions of the image. The height follows from the window's 16:10 shape. */
  crop: { x: number; y: number; w: number };
  mobile?: string;
};

// Real screens. Current ones are from the development build; two come from an
// earlier release because this build can't show them from the web client.
// Each crop zooms into the detail its caption names so the UI text stays legible.
const SHOTS: Record<string, Shot> = {
  chat: {
    src: "/screenshots/current/chat.webp",
    alt: "A paired chat between Boo and Casper with delivery receipts",
    from: "dev",
    width: 2560,
    height: 1640,
    // The conversation column: Casper's bubbles on the left, ours with "Received by peer" on the right.
    crop: { x: 0.375, y: 0.15, w: 0.625 },
    mobile: "/screenshots/current/chat-mobile.webp",
  },
  files: {
    src: "/screenshots/current/file.webp",
    alt: "An image sent in a chat, with its preview and a download button",
    from: "dev",
    width: 2560,
    height: 1640,
    // The received image bubble and the haunted-house.png row under it.
    crop: { x: 0.385, y: 0.345, w: 0.61 },
  },
  calls: {
    src: "/screenshots/current/app-audio-call.webp",
    alt: "An audio call in progress in the desktop app",
    from: "old",
    width: 1400,
    height: 1123,
    // The call band: the avatar, the name and the mic / hang-up controls. The header
    // sits too far above the controls to share a 16:10 frame with them at a legible size.
    crop: { x: 0.115, y: 0.37, w: 0.77 },
  },
  sats: {
    src: "/screenshots/current/wallet-mainnet.webp",
    alt: "The wallet with Cashu, Lightning, Ark and USDT cards",
    from: "dev",
    width: 2560,
    height: 1640,
    // The four wallet cards, the balance and the Receive / Send row.
    crop: { x: 0.355, y: 0.075, w: 0.625 },
  },
  services: {
    src: "/screenshots/current/app-friend-app.webp",
    alt: "A contact's photo gallery, served from their computer, opened in the desktop app",
    from: "old",
    width: 1400,
    height: 1123,
    // The gallery header and first rows; the browser's own title bar stays above the crop.
    crop: { x: 0.03, y: 0.045, w: 0.94 },
  },
};

/** CSS custom properties that place the picture inside the window (see .nx-shot). */
function cropVars(shot: Shot): React.CSSProperties {
  return {
    "--nx-x": shot.crop.x,
    "--nx-y": shot.crop.y,
    "--nx-w": shot.crop.w,
    "--nx-r": shot.height / shot.width,
  } as React.CSSProperties;
}

// Commands from docs/CLI.md; the watch line has the shape of the CLI's WatchEvent.
const CLI = `$ ghostly-cli identity new > ~/.ghostly-identity.json
$ ghostly-cli invite new --seed "$SEED"
$ ghostly-cli send --seed "$SEED" --peer "$PEER" --key "$KEY" "Boo! 👻"
$ ghostly-cli watch --seed "$SEED" --peer "$PEER" --key "$KEY"
{"from":"…","text":"deploy?","timestamp":1790000000,"nick":"Casper"}`;

const WIDE = "(min-width: 861px) and (prefers-reduced-motion: no-preference)";

function Bar() {
  return (
    <div className="nx-bar" aria-hidden="true">
      <i />
      <i />
      <i />
    </div>
  );
}

export function NextSection({ t, locale }: { t: HomeCopy["next"]; locale: Locale }) {
  const gradId = useId().replace(/:/g, "");
  const headRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLLIElement | null)[]>([]);
  const activeRef = useRef(0);
  const [active, setActive] = useState(0);
  const [dir, setDir] = useState<1 | -1>(1);
  const [drawn, setDrawn] = useState(false);

  const items = t.items;
  const chatIndex = items.findIndex((i) => i.id === "chat");
  const cliIndex = items.findIndex((i) => !SHOTS[i.id]);
  const honesty = (id: string) => {
    const shot = SHOTS[id];
    if (!shot) return t.illustration;
    return shot.from === "dev" ? t.fromDev.replace("{n}", NEXT_VERSION) : t.fromOld;
  };

  // The live line draws once, when the head comes into view.
  useEffect(() => {
    const el = headRef.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setDrawn(true);
      return;
    }
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setDrawn(true);
          io.disconnect();
        }
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // One observer on the captions picks which screen the window shows.
  useEffect(() => {
    const mq = window.matchMedia(WIDE);
    let io: IntersectionObserver | null = null;
    const start = () => {
      io?.disconnect();
      io = null;
      if (!mq.matches) return;
      const els = itemRefs.current.filter((el): el is HTMLLIElement => !!el);
      io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            const i = els.indexOf(e.target as HTMLLIElement);
            if (i < 0 || i === activeRef.current) continue;
            setDir(i > activeRef.current ? 1 : -1);
            activeRef.current = i;
            setActive(i);
          }
        },
        { threshold: 0.5 },
      );
      els.forEach((el) => io!.observe(el));
    };
    start();
    mq.addEventListener("change", start);
    return () => {
      mq.removeEventListener("change", start);
      io?.disconnect();
    };
  }, []);

  return (
    <section className="section nx" id="next">
      <div className="wrap">
        <div className="nx-head" ref={headRef}>
          <span className="eyebrow">{t.eyebrow}</span>
          <div className="nx-cast">
            <span className="nx-cast-boo" aria-hidden="true">
              <Ghost who="boo" mood="talk" look={{ x: 1, y: 0.2 }} size={56} float={false} />
            </span>
            <h2 className="h-section nx-h2">{t.title}</h2>
            <svg className="nx-line" data-drawn={drawn} viewBox="0 0 100 2" preserveAspectRatio="none" focusable="false" aria-hidden="true">
              <defs>
                <linearGradient id={`nx-line-grad-${gradId}`} gradientUnits="userSpaceOnUse" x1="0" y1="1" x2="100" y2="1">
                  <stop offset="0" stopColor="#22d3ee" />
                  <stop offset="1" stopColor="#4ade80" />
                </linearGradient>
              </defs>
              <path d="M0 1 H100" style={{ stroke: `url(#nx-line-grad-${gradId})` }} />
            </svg>
            <span className="nx-cast-casper" aria-hidden="true">
              <Ghost who="casper" mood="happy" look={{ x: -1, y: 0.2 }} size={56} float={false} phase={1} />
            </span>
          </div>
          <p className="lead">{t.lead}</p>
        </div>

        <div className="nx-body">
          <ol className="nx-list">
            {items.map((item, i) => {
              const shot = SHOTS[item.id];
              return (
                <li
                  key={item.id}
                  id={`next-${item.id}`}
                  className="nx-item"
                  data-active={i === active}
                  ref={(el) => {
                    itemRefs.current[i] = el;
                  }}
                >
                  <figure className="nx-row-media">
                    <div className="nx-win nx-win--light">
                      <Bar />
                      {shot ? (
                        <div className="nx-screen" style={cropVars(shot)}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img className="nx-shot" src={shot.src} alt={shot.alt} loading="lazy" decoding="async" width={shot.width} height={shot.height} />
                        </div>
                      ) : (
                        <pre className="nx-term" aria-label="Example CLI session">
                          <code>{CLI}</code>
                        </pre>
                      )}
                    </div>
                    <figcaption className="caption">{honesty(item.id)}</figcaption>
                  </figure>
                  <div className="nx-copy">
                    <h3 className="h-card nx-title">{item.title}</h3>
                    <p className="body">{item.body}</p>
                    <div className="nx-badges">
                      <LevelBadge level={item.level} locale={locale} />
                      {"extraLevel" in item && item.extraLevel && <LevelBadge level={item.extraLevel} locale={locale} />}
                    </div>
                    {item.extra && <p className="note nx-note">{item.extra}</p>}
                    {"link" in item && item.link && (
                      <Link className="link-arrow" href={item.link.href}>
                        {item.link.label} →
                      </Link>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>

          <div className="nx-stage">
            <div className="nx-sticky">
              <div className="nx-device">
                <div className="nx-win nx-win--stage" data-cli={active === cliIndex}>
                  <Bar />
                  <div className="nx-screen" style={{ "--dir": dir } as React.CSSProperties}>
                    {items.map((item, i) => {
                      const shot = SHOTS[item.id];
                      if (!shot) {
                        return (
                          <pre key={item.id} className="nx-term nx-term--stage nx-swap" data-on={i === active} aria-hidden={i !== active || undefined} aria-label="Example CLI session">
                            <code>{CLI}</code>
                          </pre>
                        );
                      }
                      return (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          key={item.id}
                          className="nx-shot nx-swap"
                          src={shot.src}
                          alt={shot.alt}
                          data-on={i === active}
                          aria-hidden={i !== active || undefined}
                          loading={i === 0 ? "eager" : "lazy"}
                          decoding="async"
                          width={shot.width}
                          height={shot.height}
                          style={cropVars(shot)}
                        />
                      );
                    })}
                  </div>
                </div>
                {chatIndex >= 0 && SHOTS.chat.mobile && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className="nx-phone" src={SHOTS.chat.mobile} alt="" data-on={active === chatIndex} aria-hidden="true" loading="lazy" decoding="async" width={780} height={1688} />
                )}
              </div>
              <p className="caption nx-honesty">{honesty(items[active]?.id ?? "")}</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
