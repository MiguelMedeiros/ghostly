"use client";

import { useEffect, useRef, useState } from "react";
import { useMotionValueEvent, useReducedMotion, useScroll } from "motion/react";
import { StoryIllustration } from "./StoryIllustration";
import { GhostGlyph, Icon } from "../icons";
import { beat, chapters, clamp, mix } from "./timeline";

function useStoryView() {
  const reduced = useReducedMotion();
  const [view, setView] = useState({
    mounted: false,
    compact: false,
    short: false,
  });
  useEffect(() => {
    const narrow = window.matchMedia("(max-width: 760px)");
    const short = window.matchMedia("(max-height: 540px)");
    const update = () =>
      setView({ mounted: true, compact: narrow.matches, short: short.matches });
    update();
    narrow.addEventListener("change", update);
    short.addEventListener("change", update);
    return () => {
      narrow.removeEventListener("change", update);
      short.removeEventListener("change", update);
    };
  }, []);
  return {
    compact: view.compact,
    still: view.short || (view.mounted && !!reduced),
  };
}

function useSectionProgress(pinned = false) {
  const ref = useRef<HTMLElement>(null);
  const [progress, setProgress] = useState(0);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: pinned ? ["start start", "end end"] : ["start 85%", "end 30%"],
  });
  useMotionValueEvent(scrollYProgress, "change", (value) =>
    setProgress(clamp(value)),
  );
  return { ref, progress };
}

type View = ReturnType<typeof useStoryView>;

function Opening() {
  return (
    <section id="beginning" className="journey-hero">
      <div className="journey-hero-grid landing-wrap">
        <div className="journey-hero-copy">
          <p className="journey-eyebrow">GHOSTLY · A PEER-TO-PEER STORY</p>
          <h1>
            Even ghosts
            <br />
            need a<br />
            <em>connection.</em>
          </h1>
          <p className="journey-description">
            Private chat, calls and sharing. Peer to peer.
            <br />
            Meet Boo. Their story could be yours.
          </p>
          <div className="journey-actions">
            <a
              className="story-cta"
              href="https://app.ghostly.tools"
              target="_blank"
              rel="noopener noreferrer"
            >
              Start your story <span>↗</span>
            </a>
            <a className="journey-link" href="#how-it-works">
              Meet Boo <span>↓</span>
            </a>
          </div>
          <p className="journey-hero-note">
            No account. No phone number. Just a connection.
          </p>
        </div>
        <div className="journey-hero-art" aria-hidden="true">
          <div className="journey-hello">Is anybody out there?</div>
          <GhostGlyph className="journey-big-ghost" />
          <span className="journey-ghost-shadow" />
          <span className="journey-ghost-name">BOO</span>
        </div>
      </div>
      <a className="journey-hero-scroll" href="#how-it-works">
        A little story about finding each other <span>↓</span>
      </a>
    </section>
  );
}

function Invitation({ compact, still }: View) {
  const { ref, progress } = useSectionProgress();
  const time = still ? 1.8 : mix(1.15, 1.8, beat(progress, 0.04, 0.74));
  return (
    <section ref={ref} id="how-it-works" className="journey-invite">
      <div className="landing-wrap journey-split">
        <div className="journey-copy">
          <p className="journey-eyebrow">A LITTLE HELLO</p>
          <h2>
            It starts with
            <br />a little <em>“boo.”</em>
          </h2>
          <p className="journey-description">
            Boo makes a private invitation. Casper accepts. That little link
            gives them the identities and shared secret to find each other.
          </p>
          <div className="journey-invite-key">
            <Icon name="key" />
            <span>
              One invitation.
              <br />
              <strong>A connection that’s only theirs.</strong>
            </span>
          </div>
          <p className="journey-note">
            Every connection gets its own identities. The invitation contains
            the keys — keep it private.
          </p>
        </div>
        <div className="journey-invite-art">
          <StoryIllustration time={time} compact={compact} />
        </div>
      </div>
    </section>
  );
}

const discoveryStart = 2.05;
const discoveryEnd = 4.82;
const discoveryTravel = 220;

function Discovery({ compact, still }: View) {
  const { ref, progress } = useSectionProgress(true);
  const t = mix(discoveryStart, discoveryEnd, progress);
  const active = Math.min(4, Math.floor(t));
  const scenes = [2, 3, 4];
  const opacity = (i: number) =>
    (i === 2 ? 1 : beat(t, i, i + 0.15)) *
    (i === 4 ? 1 : 1 - beat(t, i + 0.88, i + 1));
  return (
    <section
      ref={ref}
      id="protocol"
      className={`journey-discovery${still ? " is-still" : ""}`}
      aria-label="How Boo and Casper find each other"
    >
      {still ? (
        <div className="landing-wrap journey-discovery-reader">
          {scenes.map((i) => (
            <article key={i} id={chapters[i].id}>
              <p className="journey-eyebrow">
                {chapters[i].label.split(" / ")[1]}
              </p>
              <h2>
                {chapters[i].title}
                <br />
                <em>{chapters[i].accent}</em>
              </h2>
              <p className="journey-description">{chapters[i].description}</p>
              <div>
                <StoryIllustration time={i + 0.8} compact={compact} />
              </div>
              <p className="journey-note">{chapters[i].note}</p>
            </article>
          ))}
        </div>
      ) : (
        <>
          <div className="discovery-anchors" aria-hidden="true">
            {scenes.map((i) => (
              <span
                key={i}
                id={chapters[i].id}
                style={{
                  top: `${i === 2 ? 0 : ((i + 0.65 - discoveryStart) / (discoveryEnd - discoveryStart)) * discoveryTravel}svh`,
                }}
              />
            ))}
          </div>
          <div className="discovery-viewport" data-discovery-step={active}>
            <div className="discovery-copy">
              {scenes.map((i) => (
                <div
                  key={i}
                  className={`discovery-caption discovery-caption-${i}`}
                  aria-hidden={active !== i}
                  style={{
                    opacity: opacity(i),
                    visibility: opacity(i) === 0 ? "hidden" : "visible",
                    transform: `translateY(${(1 - opacity(i)) * 12}px)`,
                  }}
                >
                  <p className="journey-eyebrow">
                    {chapters[i].label.split(" / ")[1]}
                  </p>
                  <h2>
                    {chapters[i].title}
                    <br />
                    <em>{chapters[i].accent}</em>
                  </h2>
                  <p className="journey-description">
                    {chapters[i].description}
                  </p>
                </div>
              ))}
            </div>
            <div className="discovery-art">
              <StoryIllustration time={t} compact={compact} />
            </div>
            <div className="discovery-notes">
              {scenes.map((i) => (
                <p
                  key={i}
                  aria-hidden={active !== i}
                  style={{ opacity: opacity(i) }}
                >
                  {chapters[i].note}
                </p>
              ))}
            </div>
            <nav className="discovery-steps" aria-label="Discovery stages">
              {scenes.map((i, n) => (
                <a
                  key={i}
                  href={`#${chapters[i].id}`}
                  aria-current={i === active ? "step" : undefined}
                >
                  <span>0{n + 1}</span>
                  {["Publish", "Unlock", "Connect"][n]}
                  <i style={{ transform: `scaleX(${clamp(t - i)})` }} />
                </a>
              ))}
            </nav>
            <a className="discovery-next" href="#capabilities">
              Then, the good part <span>↓</span>
            </a>
          </div>
        </>
      )}
    </section>
  );
}

function Conversation() {
  const [mode, setMode] = useState<"chat" | "call" | "screen">("chat");
  return (
    <section
      id="capabilities"
      className="journey-conversation landing-wrap"
      aria-labelledby="possibilities-heading"
    >
      <div className="journey-section-intro">
        <p className="journey-eyebrow">NOW THAT WE’RE CONNECTED</p>
        <h2 id="possibilities-heading">
          A private little line.
          <br />
          <em>A whole world opens.</em>
        </h2>
      </div>
      <div id="features" className="journey-conversation-grid">
        <div className="journey-copy">
          <p className="journey-eyebrow">STAY A LITTLE LONGER</p>
          <h3>
            A message.
            <br />A voice.
            <br />
            <em>A familiar face.</em>
          </h3>
          <p className="journey-description">
            The search is over. Say hello, turn on the camera, or show what’s on
            your screen. All inside the same private connection.
          </p>
          <div
            className="journey-demo-options"
            role="group"
            aria-label="Preview communication features"
          >
            {(
              [
                ["chat", "Chat", "chat"],
                ["call", "Call", "video"],
                ["screen", "Screen", "desktop"],
              ] as const
            ).map(([value, label, icon]) => (
              <button
                key={value}
                type="button"
                onClick={() => setMode(value)}
                aria-pressed={mode === value}
              >
                <Icon name={icon} />
                {label}
              </button>
            ))}
          </div>
          <p className="journey-note">
            End-to-end encrypted. Screen sharing needs a supported computer.
            Both contacts must be online for calls.
          </p>
        </div>
        <div className="conversation-demo" aria-label={`${mode} illustration`}>
          <div className="conversation-demo-top">
            <span className="conversation-avatar">
              <GhostGlyph />
            </span>
            <span>
              Casper
              <small>
                <i /> Connected to you
              </small>
            </span>
            <Icon name="lock" />
          </div>
          <div key={mode} className="conversation-demo-body">
            {mode === "chat" ? (
              <div className="conversation-bubbles">
                <p className="bubble-boo">
                  Finally found you.<small>Delivered ✓✓</small>
                </p>
                <p className="bubble-casper">I’ve got all night.</p>
                <p className="bubble-boo">
                  There’s something I want to show you. <span>↗</span>
                </p>
                <div className="conversation-tiny-ghost">
                  <GhostGlyph />
                  <span>Some things are better shared.</span>
                </div>
              </div>
            ) : mode === "call" ? (
              <div className="conversation-call">
                <div>
                  <GhostGlyph />
                  <span>You</span>
                </div>
                <div>
                  <GhostGlyph />
                  <span>Casper</span>
                </div>
                <p>
                  <Icon name="lock" /> An encrypted moment together.
                </p>
                <div className="conversation-call-controls">
                  <span>
                    <Icon name="mic" />
                  </span>
                  <span>
                    <Icon name="video" />
                  </span>
                  <span>
                    <Icon name="leave" />
                  </span>
                </div>
              </div>
            ) : (
              <div className="conversation-screen">
                <div>
                  <span>BOO’S SCREEN</span>
                  <p>
                    Here’s what
                    <br />
                    I’ve been <em>making.</em>
                  </p>
                  <GhostGlyph />
                </div>
                <p>
                  <Icon name="desktop" /> Sharing a screen. Keeping the
                  conversation.
                </p>
              </div>
            )}
          </div>
          <div className="conversation-demo-bottom">
            <span>Illustrated preview</span>
            <span>Chat · GIFs · Voice · Video · Screen</span>
          </div>
        </div>
      </div>
    </section>
  );
}

function Sharing({ still }: View) {
  const { ref, progress } = useSectionProgress();
  const file = still ? 1 : beat(progress, 0.04, 0.52);
  const sats = still ? 1 : beat(progress, 0.48, 0.73);
  return (
    <section
      ref={ref}
      id="send"
      className="journey-sharing landing-wrap"
      aria-labelledby="sharing-heading"
    >
      <div className="journey-sharing-heading">
        <p className="journey-eyebrow">PASS SOMETHING ALONG</p>
        <h2 id="sharing-heading">
          “This made me
          <br />
          <em>think of you.”</em>
        </h2>
        <p className="journey-description">
          Send the thing you made.
          <br />
          Send a little thank-you back.
        </p>
      </div>
      <div className="journey-sharing-grid">
        <article className="journey-file-card">
          <div className="journey-card-kicker">
            <Icon name="file" />
            <span>FILES, FROM DEVICE TO DEVICE</span>
          </div>
          <h3>
            A photo. A project.
            <br />
            <em>Up to 100 MiB.</em>
          </h3>
          <div className="journey-file-demo" aria-hidden="true">
            <div className="journey-file-sheet back" />
            <div
              className="journey-file-sheet"
              style={{
                transform: `translateY(${(1 - file) * 40}px) rotate(${mix(-9, -3, file)}deg)`,
              }}
            >
              <Icon name="file" />
              <span>
                midnight
                <br />
                project.zip
              </span>
              <small>12.4 MiB</small>
            </div>
            <div className="journey-transfer">
              <span>
                Sending to Casper <b>{Math.round(file * 100)}%</b>
              </span>
              <i>
                <i style={{ transform: `scaleX(${file})` }} />
              </i>
            </div>
          </div>
          <p>
            Encrypted transfers, image previews and live progress. Right in the
            conversation.
          </p>
          <small>
            Both contacts must be online. Received files stay on your device.
          </small>
        </article>
        <article className="journey-sats-card">
          <div className="journey-card-kicker">
            <Icon name="bolt" />
            <span>A LITTLE VALUE, TOO</span>
          </div>
          <h3>
            Good work deserves
            <br />
            <em>a little lightning.</em>
          </h3>
          <div className="journey-sats-demo" aria-hidden="true">
            <div
              className="journey-coin"
              style={{ transform: `translateY(${(1 - sats) * 24}px)` }}
            >
              <Icon name="bolt" />
            </div>
            <span>
              21 <small>sats</small>
            </span>
            <p style={{ opacity: 0.3 + sats * 0.7 }}>
              {sats > 0.9
                ? "A thank-you from Casper. ✓"
                : "A thank-you, on its way."}
            </p>
          </div>
          <p>
            Send or request sats in chat. A Cashu wallet, with Lightning
            payments in and out.
          </p>
          <small>
            Ecash mints hold the funds. Backup tokens are available in wallet
            settings.
          </small>
        </article>
      </div>
    </section>
  );
}

function LocalApp({ still }: View) {
  const { ref, progress } = useSectionProgress(true);
  const [sharing, setSharing] = useState(true);
  const [interacted, setInteracted] = useState(false);
  const reveal = still || interacted ? 1 : beat(progress, 0.12, 0.72);
  return (
    <section
      ref={ref}
      id="local-apps"
      className={`journey-local${still ? " is-still" : ""}`}
      aria-labelledby="journey-local-heading"
    >
      <div className="journey-local-pin">
        <div className="landing-wrap">
          <div className="journey-local-heading">
            <div>
              <p className="journey-eyebrow">OPEN A LITTLE DOOR</p>
              <h2 id="journey-local-heading">
                Your localhost.
                <br />
                <em>Their next tab.</em>
              </h2>
            </div>
            <p>
              Boo built something. Casper can actually use it — running on Boo’s
              computer, through Ghostly.
            </p>
          </div>
          <div className="journey-local-demo">
            <div className="journey-local-device">
              <span className="journey-local-device-label">
                <GhostGlyph /> BOO’S COMPUTER
              </span>
              <div className="journey-local-browser journey-local-source">
                <div className="journey-local-browser-bar">
                  <span>● ● ●</span>
                  <code>localhost:3000</code>
                </div>
                <div className="journey-local-studio">
                  <span>MIDNIGHT STUDIO</span>
                  <p>
                    Made
                    <br />
                    <em>here.</em>
                  </p>
                  <GhostGlyph />
                </div>
              </div>
              <span className="journey-local-under-label">
                The app keeps running here.
              </span>
            </div>
            <div className="journey-local-bridge" aria-hidden="true">
              <span style={{ transform: `scaleX(${reveal})` }} />
              <Icon name="lock" />
            </div>
            <div
              className="journey-local-device journey-local-recipient"
              style={{
                opacity: 0.2 + 0.8 * reveal,
                transform: `translateX(${(1 - reveal) * -45}px)`,
              }}
            >
              <span className="journey-local-device-label">
                <GhostGlyph /> CASPER’S COMPUTER
              </span>
              <div className="journey-local-browser journey-local-destination">
                <div className="journey-local-browser-bar">
                  <span>● ● ●</span>
                  <code>via Ghostly</code>
                </div>
                {sharing ? (
                  <div className="journey-local-studio">
                    <span>MIDNIGHT STUDIO</span>
                    <p>
                      Open
                      <br />
                      <em>over there.</em>
                    </p>
                    <GhostGlyph />
                  </div>
                ) : (
                  <div className="journey-local-closed">
                    <Icon name="lock" />
                    <p>The door is closed.</p>
                    <span>Access through Ghostly is off.</span>
                  </div>
                )}
              </div>
              <span className="journey-local-under-label">
                {sharing
                  ? "The same app. Through your connection."
                  : "Boo’s app stays on Boo’s computer."}
              </span>
            </div>
          </div>
          <div className="journey-local-bottom">
            <button
              type="button"
              role="switch"
              aria-checked={sharing}
              aria-label="Preview sharing a local app"
              onClick={() => {
                setSharing((v) => !v);
                setInteracted(true);
              }}
            >
              <span className={`journey-local-switch ${sharing ? "on" : ""}`}>
                <i />
              </span>
              {sharing ? "Sharing with linked contacts" : "Sharing is off"}
              <small>Try it</small>
            </button>
            <p>
              Desktop or extension on both ends. Enabled apps are available to
              all linked contacts while you’re online.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function Automation({ still }: View) {
  const { ref, progress } = useSectionProgress();
  const delivered = still ? 1 : beat(progress, 0.12, 0.58);
  return (
    <section
      ref={ref}
      id="automation"
      className="journey-automation landing-wrap journey-split"
    >
      <div className="journey-copy">
        <p className="journey-eyebrow">LET YOUR CODE JOIN IN</p>
        <h2>
          Even your code
          <br />
          <em>can say boo.</em>
        </h2>
        <p className="journey-description">
          Give your scripts, bots and AI agents a private line. Send a message
          from the terminal. Let your tools listen and reply.
        </p>
        <a href="/cli" className="journey-link">
          Explore the CLI <span>↗</span>
        </a>
        <p className="journey-note">
          Encrypted text, JSON output and an NDJSON stream. Your code supplies
          the automation.
        </p>
      </div>
      <div className="journey-terminal-wrap">
        <div className="journey-terminal">
          <div>
            <span>● ● ●</span>
            <span>BOO’S TERMINAL</span>
          </div>
          <pre>
            <code>
              <span>$ ghostly-cli send \</span>
              {
                '\n  --seed "$SEED" --peer "$PEER" \\\n  --key "$KEY" "Your build is ready."'
              }
            </code>
          </pre>
          <p style={{ opacity: delivered }}>
            <Icon name="check" /> Delivered to Casper.
          </p>
        </div>
        <div
          className="journey-bot-reply"
          style={{
            opacity: delivered,
            transform: `translateY(${(1 - delivered) * 20}px)`,
          }}
        >
          <GhostGlyph />
          <span>
            <small>CASPER</small>Perfect. Opening it now.
          </span>
        </div>
      </div>
    </section>
  );
}

function Goodnight({ compact, still }: View) {
  const { ref, progress } = useSectionProgress();
  const t = still ? 9.94 : mix(9.08, 9.94, beat(progress, 0.04, 0.8));
  return (
    <section ref={ref} id="goodnight" className="journey-goodnight">
      <div className="landing-wrap journey-split">
        <div className="journey-goodnight-art">
          <StoryIllustration time={t} compact={compact} />
        </div>
        <div className="journey-copy">
          <p className="journey-eyebrow">UNTIL NEXT TIME</p>
          <h2>
            The signal fades.
            <br />
            <em>What’s yours stays yours.</em>
          </h2>
          <p className="journey-description">
            Boo goes offline. The live channel closes. Without fresh
            publications, the network records gradually expire.
          </p>
          <p className="journey-note">
            Expiry isn’t instant erasure. Your identities, history, files and
            wallet stay on your device until you delete them.
          </p>
          <a className="journey-link" href="#details">
            Every possibility, in detail <span>↓</span>
          </a>
        </div>
      </div>
    </section>
  );
}

export function GhostStory() {
  const view = useStoryView();
  return (
    <div className="ghost-journey">
      <Opening />
      <Invitation {...view} />
      <Discovery {...view} />
      <Conversation />
      <Sharing {...view} />
      <LocalApp {...view} />
      <Automation {...view} />
      <Goodnight {...view} />
    </div>
  );
}
