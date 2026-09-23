import Link from "next/link";
import { TechnologyCredits } from "@/components/presentation/TechnologyCredits";
import { Shell, Eyebrow } from "@/components/presentation/Shell";
import { ConnectionStory } from "@/components/presentation/Scene";
import { GhostConversation, GhostParticles } from "@/components/GhostScene";
import { GhostGlyph, Icon, type IconName } from "@/components/icons";
import { RELEASE_URL, VERSION } from "@/lib/release";

const features: {
  icon: IconName;
  title: string;
  body: string;
  detail: string;
  label: string;
}[] = [
  {
    icon: "chat",
    title: "Say it your way.",
    body: "Private messages, without signing up for a public identity.",
    detail:
      "Current paired chats use authenticated participation, contact pins, local history and delivery receipts. A receipt means your contact’s device persisted the message.",
    label: "Chat",
  },
  {
    icon: "file",
    title: "Send the actual thing.",
    body: "Photos, projects and files. From your device to theirs.",
    detail:
      "Paired files are negotiated by both peers, with integrity checks and receipts. Up to 100 MiB per file; both contacts must be online. Retry restarts the file, rather than resuming partial bytes.",
    label: "Files",
  },
  {
    icon: "bolt",
    title: "A little thank-you.",
    body: "Send or request sats right in the conversation.",
    detail:
      "The current wallet uses Cashu, with Lightning payments in and out. Mints hold the funds. Paired payments require mutual support; backup tokens are available, but are not a complete device-recovery guarantee.",
    label: "Sats",
  },
  {
    icon: "video",
    title: "Be a little closer.",
    body: "Voice, video and screen sharing in compatible chats.",
    detail:
      "Available in supported legacy WebRTC chats, not the current paired profile. Both contacts must be online. Screen sharing needs a supported computer; native WebView media support varies.",
    label: "Compatible legacy chats",
  },
  {
    icon: "desktop",
    title: "Made here. Open there.",
    body: "Let a contact use an app running on your computer.",
    detail:
      "Local HTTP apps use compatible legacy chats with desktop or extension at both ends. Enabled apps are shared with linked contacts while you are online. This is not yet part of paired sessions.",
    label: "Compatible legacy chats",
  },
  {
    icon: "terminal",
    title: "Give your code a voice.",
    body: "A private line for scripts, bots and your own tools.",
    detail:
      "The existing CLI provides text messaging, JSON output and an NDJSON stream. It does not imply feature parity with current paired clients. Your own code supplies the automation.",
    label: "CLI",
  },
];
export default function Home() {
  return (
    <Shell finale>
      <section className="p-hero p-original-hero" id="beginning">
        <GhostParticles />
        <div className="p-wrap hero-haunt">
          <div className="hero-badge">
            <GhostGlyph /> Peer to peer. No account required.
          </div>
          <h1 aria-label="Ghostly">
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
          <GhostConversation intro />
          <h2 className="hero-promise">
            Private chat and sharing, <span>peer to peer.</span>
          </h2>
          <p className="p-lead">
            Chat, send files and sats. Connect with your people, without a
            public account.
          </p>
          <div className="p-actions">
            <a className="p-button" href="https://app.ghostly.tools">
              <GhostGlyph /> Open in your browser <span>↗</span>
            </a>
            <a className="p-button secondary" href="#download">
              Download the app <span>↓</span>
            </a>
          </div>
          <p className="p-micro">Nothing to install. Free and open source.</p>
          <a className="p-text-link" href="#story">
            Meet Boo & Casper <span>↓</span>
          </a>
        </div>
      </section>
      <ConnectionStory />
      <section className="p-section p-wrap" id="possibilities">
        <div className="p-section-heading">
          <div>
            <Eyebrow>02 — NOW THAT WE’RE CONNECTED</Eyebrow>
            <h2>
              Everything a <em>ghost</em> can do
            </h2>
          </div>
          <p>
            Start with a conversation.
            <br />
            See what your connection can do.
          </p>
        </div>
        <div className="p-feature-grid">
          {features.map((f) => (
            <article className="p-feature" key={f.title}>
              <div className="p-feature-top">
                <Icon name={f.icon} />
                <span>{f.label}</span>
              </div>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
              <details>
                <summary>
                  How it works <span>+</span>
                </summary>
                <p>{f.detail}</p>
                {f.label === "CLI" && (
                  <Link href="/cli">Read the CLI guide ↗</Link>
                )}
              </details>
            </article>
          ))}
        </div>
        <p className="p-footnote">
          Availability depends on your client, chat profile and what both
          contacts support. The local development build adds negotiated files
          and sats; public downloads may differ.{" "}
          <Link href="/developers#availability">See the current scope ↗</Link>
        </p>
        <div className="p-small-things">
          <strong>And the little things.</strong>
          <span>QR invitations</span>
          <span>Local nicknames</span>
          <span>Light & dark themes</span>
          <span>8 languages</span>
          <span>App lock</span>
        </div>
      </section>
      <section className="p-quiet">
        <div className="p-wrap p-split">
          <div>
            <Eyebrow>03 — YOUR CONNECTION, YOUR SPACE</Eyebrow>
            <h2>
              A presence.
              <br />
              Not a permanent
              <br />
              <em>broadcast.</em>
            </h2>
          </div>
          <div className="p-prose">
            <p>
              Your devices publish small discovery records so they can find each
              other. The network distributes them. Your private invitation
              supplies the keys needed to understand the encrypted information.
            </p>
            <p>
              When you stop publishing, network records eventually expire. That
              does not erase copies elsewhere, or the history and files on your
              own device.
            </p>
            <details>
              <summary>What about offline messages?</summary>
              <p>
                The current DHT-only path is for very short text, with a
                five-minute acceptance and retry window. Publishing is not a
                delivery receipt. Files and calls need a live connection.
              </p>
            </details>
          </div>
        </div>
      </section>
      <section className="p-section p-wrap p-developer-invite">
        <div>
          <Eyebrow>SMALL CORE. BIG POSSIBILITIES.</Eyebrow>
          <h2>
            There’s a protocol
            <br />
            under these <em>ghosts.</em>
          </h2>
          <p>
            The app is a beginning. Ghostly’s direction is a common way for
            independent tools to agree, connect and work together.
          </p>
          <Link className="p-button secondary" href="/developers">
            Build with Ghostly <span>↗</span>
          </Link>
        </div>
        <div
          className="p-contract-preview"
          aria-label="Architecture: experiences use capabilities, implemented by adapters"
        >
          <span>YOUR NEXT IDEA</span>
          <strong>chat · payments · social apps</strong>
          <b>shared contracts</b>
          <span>independent adapters</span>
          <small>Social apps & new adapters are roadmap directions.</small>
        </div>
      </section>
      <section className="p-section p-download" id="download">
        <div className="p-wrap">
          <Eyebrow>MAKE YOURSELF AT HOME</Eyebrow>
          <h2>
            One little step.
            <br />
            <em>You’re here.</em>
          </h2>
          <div className="p-download-grid">
            <article>
              <Icon name="globe" />
              <h3>Start in your browser.</h3>
              <p>No installation. Open a tab and invite someone you know.</p>
              <a className="p-button" href="https://app.ghostly.tools">
                Open Ghostly ↗
              </a>
            </article>
            <article>
              <Icon name="desktop" />
              <h3>Stay on your desktop.</h3>
              <p>
                macOS, Windows and Linux. Find the right installer and browser
                extension in the release assets.
              </p>
              <a className="p-button secondary" href={RELEASE_URL}>
                Download v{VERSION} ↗
              </a>
            </article>
          </div>
          <p className="p-footnote">
            Public release downloads are separate from this local development
            preview. Check release notes for the features in your build.
          </p>
        </div>
      </section>
      <TechnologyCredits />
    </Shell>
  );
}
