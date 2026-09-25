"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { Ghost } from "@/components/ghost/Ghost";
import { NEXT_VERSION } from "@/lib/status";
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
  /** The same screen on a phone (390 × 844 at 2×), shown whole beside the window. */
  mobile?: string;
};

// Real screens from the app, each with its phone counterpart.
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
    mobile: "/screenshots/current/file-mobile.webp",
  },
  calls: {
    src: "/screenshots/current/call.webp",
    alt: "An audio call with Casper in progress: the timer, the name and the mute, camera, screen and hang-up controls",
    from: "dev",
    width: 2560,
    height: 1640,
    // The call band: the avatar, the name and the controls fill the frame; the timer
    // sits too far above them to share a 16:10 frame.
    crop: { x: 0.19, y: 0.35, w: 0.62 },
    mobile: "/screenshots/current/call-mobile.webp",
  },
  sats: {
    src: "/screenshots/current/wallet-mainnet.webp",
    alt: "The wallet with Cashu, Lightning, Ark and USDT cards",
    from: "dev",
    width: 2560,
    height: 1640,
    // The four wallet cards, the balance and the Receive / Send row.
    crop: { x: 0.355, y: 0.075, w: 0.625 },
    mobile: "/screenshots/current/wallet-mobile.webp",
  },
  services: {
    src: "/screenshots/current/services-chat.webp",
    alt: "Choosing which of your apps a contact can open",
    from: "dev",
    width: 2560,
    height: 1640,
    // The "Apps with Casper" sheet over the chat, the bubble above it kept whole.
    crop: { x: 0.275, y: 0.26, w: 0.45 },
    mobile: "/screenshots/current/services-mobile.webp",
  },
  groups: {
    src: "/screenshots/current/groups.webp",
    alt: "A private group called Haunted house with Boo, Casper and Spooky talking",
    from: "dev",
    width: 2560,
    height: 1640,
    // The conversation column with the group header and the three voices.
    crop: { x: 0.36, y: 0.0, w: 0.64 },
    mobile: "/screenshots/current/groups-mobile.webp",
  },
  identities: {
    src: "/screenshots/current/identities-chat.webp",
    alt: "Casper's chat with Boo, the Identities dialog open: Boo's SSH key and OpenPGP key, each verified as their own key",
    from: "dev",
    width: 2560,
    height: 1640,
    // The "Identities with Boo" dialog whole, with a little of the chat around it.
    crop: { x: 0.26, y: 0.215, w: 0.58 },
    mobile: "/screenshots/current/identities-chat-mobile.webp",
  },
};

/** Phone screenshots are 390 × 844 at 2×. */
const PHONE = { width: 780, height: 1688 };

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

export function NextSection({ t }: { t: HomeCopy["next"] }) {
  const gradId = useId().replace(/:/g, "");
  const headRef = useRef<HTMLDivElement>(null);
  const copyRefs = useRef<(HTMLDivElement | null)[]>([]);
  const activeRef = useRef(0);
  const [active, setActive] = useState(0);
  const [dir, setDir] = useState<1 | -1>(1);
  const [drawn, setDrawn] = useState(false);

  const items = t.items;
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

  // Which screen the window shows: the item whose copy crosses the middle of the
  // viewport, so the reader never sees one item's words beside the next item's
  // picture. A thin observer band at the centre catches the crossings; a second
  // observer on the whole viewport catches jumps (anchors, flings) that skip the
  // band, and then the copy nearest the middle wins.
  useEffect(() => {
    const mq = window.matchMedia(WIDE);
    let observers: IntersectionObserver[] = [];
    const stop = () => {
      observers.forEach((io) => io.disconnect());
      observers = [];
    };
    const start = () => {
      stop();
      if (!mq.matches) return;
      const els = copyRefs.current.filter((el): el is HTMLDivElement => !!el);
      const pick = () => {
        const mid = window.innerHeight / 2;
        let best = -1;
        let bestDistance = Infinity;
        els.forEach((el, i) => {
          const r = el.getBoundingClientRect();
          const d = r.top <= mid && r.bottom >= mid ? -1 : Math.min(Math.abs(r.top - mid), Math.abs(r.bottom - mid));
          if (d < bestDistance) {
            best = i;
            bestDistance = d;
          }
        });
        if (best < 0 || best === activeRef.current) return;
        setDir(best > activeRef.current ? 1 : -1);
        activeRef.current = best;
        setActive(best);
      };
      observers = [new IntersectionObserver(pick, { rootMargin: "-45% 0px -45% 0px", threshold: 0 }), new IntersectionObserver(pick, { threshold: 0 })];
      observers.forEach((io) => els.forEach((el) => io.observe(el)));
    };
    start();
    mq.addEventListener("change", start);
    return () => {
      mq.removeEventListener("change", start);
      stop();
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
                <li key={item.id} id={`next-${item.id}`} className="nx-item" data-active={i === active}>
                  <figure className="nx-row-media" data-phone={!!shot?.mobile}>
                    <div className="nx-win nx-win--light">
                      <Bar />
                      {shot ? (
                        <div className="nx-screen" style={cropVars(shot)}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img className="nx-shot" src={shot.src} alt={shot.alt} loading="lazy" decoding="async" width={shot.width} height={shot.height} />
                        </div>
                      ) : (
                        <pre className="nx-term" aria-label="Example CLI session" tabIndex={0}>
                          <code>{CLI}</code>
                        </pre>
                      )}
                    </div>
                    {shot?.mobile && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img className="nx-row-phone" src={shot.mobile} alt="" aria-hidden="true" loading="lazy" decoding="async" width={PHONE.width} height={PHONE.height} />
                    )}
                    <figcaption className="caption">{honesty(item.id)}</figcaption>
                  </figure>
                  <div
                    className="nx-copy"
                    ref={(el) => {
                      copyRefs.current[i] = el;
                    }}
                  >
                    <h3 className="h-card nx-title">{item.title}</h3>
                    <p className="body">{item.body}</p>
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
              <div className="nx-device" style={{ "--dir": dir } as React.CSSProperties}>
                <div className="nx-win nx-win--stage" data-cli={active === cliIndex}>
                  <Bar />
                  <div className="nx-screen">
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
                {/* One phone per screen, all standing in the same spot; only the active item's is shown. */}
                {items.map((item, i) => {
                  const mobile = SHOTS[item.id]?.mobile;
                  if (!mobile) return null;
                  return (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={item.id}
                      className="nx-phone nx-swap"
                      src={mobile}
                      alt=""
                      data-on={i === active}
                      aria-hidden="true"
                      loading={i === 0 ? "eager" : "lazy"}
                      decoding="async"
                      width={PHONE.width}
                      height={PHONE.height}
                    />
                  );
                })}
              </div>
              <p className="caption nx-honesty">{honesty(items[active]?.id ?? "")}</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
