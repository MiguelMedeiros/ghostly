"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { Ghost } from "@/components/ghost/Ghost";
import { Icon } from "@/components/site/icons";
import { Reveal } from "./Reveal";
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

// Real screens from the app (npm run capture), each with its phone counterpart.
// Each crop zooms into the detail its caption names so the UI text stays legible.
const SHOTS: Record<string, Shot> = {
  chat: {
    src: "/screenshots/current/chat.webp",
    alt: "Boo's chat with Casper: text, a voice message and delivery receipts under each message",
    from: "dev",
    width: 2560,
    height: 1640,
    // The conversation column: Casper's bubbles and voice message on the left, ours with "Received by peer" on the right.
    crop: { x: 0.345, y: 0.27, w: 0.655 },
    mobile: "/screenshots/current/chat-mobile.webp",
  },
  files: {
    src: "/screenshots/current/file.webp",
    alt: "A photo Casper sent in the chat, with its preview and a download button",
    from: "dev",
    width: 2560,
    height: 1640,
    // The received photo bubble and the lake-house.jpg row under it.
    crop: { x: 0.385, y: 0.33, w: 0.61 },
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
    src: "/screenshots/current/sats.webp",
    alt: "Paying in the chat with Casper on test networks: 2,100 sats received for the snacks, a request paid over Ark, and the deck of eight wallet cards",
    from: "dev",
    width: 2560,
    height: 1640,
    // The payment deck open over the chat (Cashu, 44,100 test sats), the thank-you and the paid request beside it.
    crop: { x: 0.33, y: 0.3, w: 0.67 },
    mobile: "/screenshots/current/sats-mobile.webp",
  },
  services: {
    src: "/screenshots/current/services-chat.webp",
    alt: "Choosing which of your apps a contact can open: Lake photos, running on Boo's computer, shared with Casper",
    from: "dev",
    width: 2560,
    height: 1640,
    // The "Apps with Casper" sheet over the chat, Lake photos switched on.
    crop: { x: 0.25, y: 0.2, w: 0.52 },
    mobile: "/screenshots/current/services-mobile.webp",
  },
  groups: {
    src: "/screenshots/current/groups.webp",
    alt: "A private group called Lake house trip: its picture, four members talking, and a request to the group paid by Wendy",
    from: "dev",
    width: 2560,
    height: 1640,
    // The conversation's end: the request to the group paid by Wendy, and the voices around it.
    crop: { x: 0.36, y: 0.36, w: 0.64 },
    mobile: "/screenshots/current/groups-mobile.webp",
  },
  identities: {
    src: "/screenshots/current/identities-chat.webp",
    alt: "Casper's chat with Boo, the identities panel open: Boo's Nostr, OpenPGP, SSH and Bitcoin identities, each verified by Casper's app",
    from: "dev",
    width: 2560,
    height: 1640,
    // The "Identities with Boo" panel: Boo's verified cards, with a little of the chat beside it.
    crop: { x: 0.44, y: 0, w: 0.56 },
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
  const [drawn, setDrawn] = useState(false);

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
      </div>

      {/* One row per thing the app does: its words beside its screens, sides alternating down the page. */}
      <ol className="wrap nx-list">
        {t.items.map((item) => {
          const shot = SHOTS[item.id];
          return (
            <Reveal as="li" key={item.id} id={`next-${item.id}`} className="nx-item">
              <div className="nx-copy">
                <span className="nx-icon" aria-hidden="true">
                  <Icon name={item.icon} />
                </span>
                <h3 className="h-card nx-title">{item.title}</h3>
                <p className="body">{item.body}</p>
                {item.extra && <p className="note nx-note">{item.extra}</p>}
                {"link" in item && item.link && (
                  <Link className="link-arrow" href={item.link.href}>
                    {item.link.label} →
                  </Link>
                )}
              </div>
              <figure className="nx-row-media" data-phone={!!shot?.mobile}>
                <div className="nx-devices">
                  <div className="nx-win">
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
                </div>
                <figcaption className="caption">{honesty(item.id)}</figcaption>
              </figure>
            </Reveal>
          );
        })}
      </ol>
    </section>
  );
}
