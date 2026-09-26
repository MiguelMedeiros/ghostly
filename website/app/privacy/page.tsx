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

const LAST_UPDATED = "September 19, 2026";

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
      <Nav locale="en" />
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
              Your identity is a keypair generated locally and never
              transmitted. Your contacts, your settings, your wallet state and
              your message history live in your browser&apos;s local storage, on
              your machine only. None of it is synced anywhere.
            </p>
            <p>
              Uninstalling the extension, or clearing the site data, erases all
              of it. There is no copy elsewhere to restore from, and we cannot
              recover it for you.
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
                To be reachable, your client publishes a signed record to a
                public distributed hash table, keyed by your public key. Anyone
                who knows your public key can look it up. That is how contacts
                reach you.
              </li>
              <li>
                <strong className="text-gray-200">
                  Encrypted message payloads.
                </strong>{" "}
                Messages sent while a contact is offline are published to the
                DHT encrypted, and expire from it in roughly five hours. They
                are readable only by the holder of the recipient key. We never
                receive them, and neither does any operator: the DHT is a public
                network of independent nodes, not a service we run.
              </li>
              <li>
                <strong className="text-gray-200">
                  Direct WebRTC connections.
                </strong>{" "}
                Chats, calls, screen sharing and file transfers run directly
                between the two browsers, end-to-end encrypted with 256-bit NaCl
                secretbox. Content never passes through an intermediary.
              </li>
            </ul>
          </Section>

          <Section title="Third parties that can see something">
            <p>
              We want to be exact about this, because &quot;peer-to-peer&quot;
              is often used to imply that nobody sees anything. Establishing a
              direct connection inherently exposes your IP address to a few
              parties:
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
                see no message content. You can replace them with your own
                STUN/TURN server in Settings.
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
                The relays observe your IP address and the public keys you
                publish or look up.
                Record contents are signed and readable, as DHT records are by
                design.
              </li>
              <li>
                <strong className="text-gray-200">GIPHY.</strong> If you search
                for or send a GIF, your browser loads that image from
                GIPHY&apos;s servers, which observe your IP address and the
                image requested. This happens only when you use the GIF feature.
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
              None of these parties receive your message content, your keys or
              your contact list.
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
              answers them with content relayed from the peer over the WebRTC
              data channel. It is the only mechanism a Chrome extension has for
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
