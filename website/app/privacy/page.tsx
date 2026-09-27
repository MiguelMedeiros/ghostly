import { Nav } from "@/components/site/Nav";
import { SiteFooter } from "@/components/site/Footer";
import { GhostPet } from "@/components/site/GhostPet";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "Ghostly has no servers and no accounts, so there is no place for your data to be collected. What stays on your device, what travels the network, and who else can see it.",
  openGraph: {
    title: "Privacy Policy | Ghostly",
    description:
      "Ghostly has no servers and no accounts. What stays on your device, what travels the network, and who else can see it.",
    type: "article",
    url: "https://ghostly.tools/privacy",
    images: [
      {
        url: "https://ghostly.tools/og-image.png",
        width: 1200,
        height: 630,
        alt: "Ghostly Privacy Policy",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Privacy Policy | Ghostly",
    description:
      "Ghostly has no servers and no accounts. What stays on your device, what travels the network, and who else can see it.",
    images: ["https://ghostly.tools/og-image.png"],
  },
};

const LAST_UPDATED = "September 27, 2026";

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-12">
      <h2 className="text-2xl font-semibold text-gray-100 mb-4">{title}</h2>
      <div className="space-y-4 text-gray-400 leading-relaxed">{children}</div>
    </section>
  );
}

export default function PrivacyPage() {
  return (
    <>
      <Nav />
      <main id="content" className="pt-16 bg-[#060a10] min-h-screen">
        <div className="max-w-3xl mx-auto px-4 py-16">
          <h1 className="text-4xl md:text-5xl font-bold mb-3 bg-gradient-to-r from-cyan-400 to-cyan-300 bg-clip-text text-transparent">
            Privacy Policy
          </h1>
          <p className="text-gray-500 mb-12 font-mono text-sm">
            Last updated: {LAST_UPDATED}
          </p>

          <p className="text-lg text-gray-300 leading-relaxed mb-12">
            Ghostly has no servers and no accounts. There is no backend that
            could receive your data, no database to hold it and no operator to
            read it. That is a property of the architecture, not a promise about
            how we behave. This page describes what stays on your device, what
            necessarily travels the network, and which third parties see
            anything at all.
          </p>

          <Section title="What we collect">
            <p>
              Nothing. Ghostly collects no personal information, no analytics,
              no telemetry, no crash reports and no usage statistics. You are
              never asked for an email address, a phone number, a username or a
              password. We operate no server that your client talks to, so there
              is no point at which your data could reach us.
            </p>
          </Section>

          <Section title="What stays on your device">
            <p>
              Your keys are generated on your device and never leave it. Your
              contacts, settings, wallets and message history live in the
              app&apos;s own storage on your machine: the browser&apos;s, the
              extension&apos;s or the desktop app&apos;s. None of it is synced
              anywhere.
            </p>
            <p>
              A backup happens only when you make one: a file sealed with your
              passphrase, which you keep, or the same sealed file in an
              S3-compatible bucket of your own. Uninstalling the app, or
              clearing the site data, erases everything else. We hold no copy
              and cannot recover it for you.
            </p>
          </Section>

          <Section title="What travels the network">
            <p>
              Ghostly is peer-to-peer, but peers still have to find each other.
              Three things leave your device:
            </p>
            <ul className="list-disc pl-6 space-y-3">
              <li>
                <strong className="text-gray-200">
                  Discovery records on the Mainline DHT.
                </strong>{" "}
                To be reachable, your app publishes small signed records to a
                public distributed hash table, under keys that belong to each
                chat. What matters inside them is sealed: only the other side of
                that chat can read it. That is how contacts reach you.
              </li>
              <li>
                <strong className="text-gray-200">
                  Short texts over the DHT.
                </strong>{" "}
                When no direct connection is up, short texts travel through the
                DHT, sealed, and expire after about five minutes. They are
                readable only by the other side of the chat. We never receive
                them, and neither does any operator: the DHT is a public network
                of independent nodes, not a service we run. If you both turn it
                on for a chat, a message for a contact who is away can also wait
                up to seven days, sealed, in the sender&apos;s own S3 bucket.
              </li>
              <li>
                <strong className="text-gray-200">Direct connections.</strong>{" "}
                Chats, calls, screen sharing, files and payment messages run
                directly between the two devices over WebRTC, Iroh or HyperDHT,
                each encrypted end to end by its transport (DTLS, QUIC with TLS,
                or Noise). When no direct path exists, a relay can carry the
                encrypted traffic without being able to read it (see Iroh
                relays below).
              </li>
            </ul>
          </Section>

          <Section title="Third parties that can see something">
            <p>
              We want to be exact about this, because &quot;peer-to-peer&quot;
              is often used to imply that nobody sees anything. Establishing a
              connection, and a few features you use, expose your IP address to
              some parties:
            </p>
            <ul className="list-disc pl-6 space-y-3">
              <li>
                <strong className="text-gray-200">STUN servers.</strong> To
                negotiate a direct connection through NAT, WebRTC contacts
                public STUN servers, by default Google&apos;s
                (<code className="text-cyan-400 text-sm">
                  stun.l.google.com
                </code>{" "}
                and its numbered siblings). They observe your IP address. They
                see no message content. You can add your own TURN server in
                Settings.
              </li>
              <li>
                <strong className="text-gray-200">Pkarr relays.</strong> A
                browser cannot reach the DHT directly, so it publishes and
                resolves records through public relays at{" "}
                <code className="text-cyan-400 text-sm">pkarr.pubky.app</code>{" "}
                and{" "}
                <code className="text-cyan-400 text-sm">pkarr.pubky.org</code>.
                Ghostly Desktop reads the DHT directly and publishes to those
                relays too, so contacts in a browser can read its records.
                The relays observe your IP address and the keys you publish or
                look up. Records are signed; what matters in them is sealed.
              </li>
              <li>
                <strong className="text-gray-200">Iroh relays.</strong> In the
                browser and the extension, Iroh connects through n0&apos;s
                public relays (
                <code className="text-cyan-400 text-sm">relay.n0.iroh.link</code>) when WebRTC cannot
                connect. A relay sees your IP address, when you connect and how
                much you send, never the content. You can set your own relays in
                Settings.
              </li>
              <li>
                <strong className="text-gray-200">Link previews.</strong> When
                you send a link, your app reads that page to make its preview,
                so the site sees your IP address. Your contact&apos;s app never
                contacts it: the preview travels inside the message. You can
                turn link previews off in Settings, Security.
              </li>
              <li>
                <strong className="text-gray-200">
                  Identities and public profiles.
                </strong>{" "}
                Checking an identity someone shared, or showing its public
                profile, asks the service behind it: Nostr relays, Pubky&apos;s
                indexer, Bluesky&apos;s public API, or a DNS-over-HTTPS resolver
                (Quad9 by default) for a domain. They see your IP address and
                which identity is looked up. Public profiles can be turned off
                in Settings, Security.
              </li>
              <li>
                <strong className="text-gray-200">GIFs and maps.</strong> GIF
                search and GIFs come from the Internet Archive (
                <code className="text-cyan-400 text-sm">gifcities.archive.org</code>,{" "}
                <code className="text-cyan-400 text-sm">web.archive.org</code>), which sees the IP address of
                whoever loads them, sender and receiver. A location card loads
                its map from OpenStreetMap only when you tap it.
              </li>
              <li>
                <strong className="text-gray-200">Wallets.</strong> A wallet
                talks to the services it runs on: a Cashu mint, an Ark server, a
                Lightning node or wallet you connect, an Ethereum RPC, a block
                explorer. They see your IP address and the operations they
                serve, and some of them (a mint, a federation) hold funds. A new
                profile has no wallet until you create one.
              </li>
              <li>
                <strong className="text-gray-200">
                  The contacts you talk to.
                </strong>{" "}
                A direct connection means the peer on the other end sees your IP
                address. Only ever connect with people you are willing to reveal
                that to.
              </li>
            </ul>
            <p>
              None of these parties receive your messages or your keys.
            </p>
          </Section>

          <Section title="The debugger permission">
            <p>
              The browser extension declares Chrome&apos;s{" "}
              <code className="text-cyan-400 text-sm">debugger</code>{" "}
              permission. It is a powerful permission and it deserves a plain
              explanation.
            </p>
            <p>
              Ghostly lets a contact open a web app you are running on your own
              machine. To deliver that app into a tab, the extension attaches
              the debugger to that specific tab, intercepts its requests, and
              answers them with content relayed from the peer over the chat&apos;s
              live connection. It is the only mechanism a Chrome extension has for
              serving a response body to a navigation request.
            </p>
            <p>
              The attach is scoped to loopback origins
              (<code className="text-cyan-400 text-sm">localhost</code>,{" "}
              <code className="text-cyan-400 text-sm">127.0.0.1</code> and{" "}
              <code className="text-cyan-400 text-sm">::1</code>) and happens
              only for a service you explicitly chose to open. The extension
              does not attach to arbitrary tabs, does not read the pages you
              browse, and requests no access to public websites. No page content
              is collected or transmitted anywhere.
            </p>
            <p>
              Content served this way comes from your contact&apos;s machine and
              runs in the page&apos;s own sandboxed context, never in the
              extension&apos;s. Open a shared service only from someone you
              trust, exactly as you would only run software from someone you
              trust.
            </p>
          </Section>

          <Section title="Children">
            <p>
              Ghostly is not directed at children under 13 and we knowingly
              collect no information from anyone, of any age.
            </p>
          </Section>

          <Section title="Changes">
            <p>
              If this policy changes, the revised version is published on this
              page with a new date above, and the change is reflected in the
              project&apos;s changelog.
            </p>
          </Section>

          <Section title="Contact">
            <p>
              Ghostly is open source under the MIT license and the entire
              codebase is open for audit. Questions, corrections and security
              reports belong on{" "}
              <a
                href="https://github.com/MiguelMedeiros/ghostly"
                className="text-cyan-400 hover:text-cyan-300 underline underline-offset-4"
                target="_blank"
                rel="noopener noreferrer"
              >
                GitHub
              </a>
              . If you find something on this page that is not true of the code,
              that is a bug, and we want to hear about it.
            </p>
          </Section>
        </div>
      </main>
      <SiteFooter />
      <GhostPet />
    </>
  );
}
