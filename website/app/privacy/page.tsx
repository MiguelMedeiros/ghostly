import type { Metadata } from "next";
import { A, Code, ISSUES_URL, LegalPage, Section, Term } from "@/components/site/Legal";
import { SECURITY_URL } from "@/content/shell";

const DESCRIPTION =
  "Ghostly has no accounts and no server that holds your data. This site sets no cookies and runs no analytics. What stays on your device, what travels the network, and who can see it.";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: DESCRIPTION,
  alternates: { canonical: "/privacy" },
  openGraph: {
    title: "Privacy Policy | Ghostly",
    description: DESCRIPTION,
    type: "article",
    url: "https://ghostly.tools/privacy",
    images: [{ url: "https://ghostly.tools/og-image.png", width: 1200, height: 630, alt: "Ghostly Privacy Policy" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Privacy Policy | Ghostly",
    description: DESCRIPTION,
    images: ["https://ghostly.tools/og-image.png"],
  },
};

const LAST_UPDATED = "September 28, 2026";

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      updated={LAST_UPDATED}
      lead={
        <>
          <p>
            Ghostly has no accounts and no server that holds your messages, contacts, keys or money. That is how it is
            built, not only a promise about how we behave. This page says what our websites see, what stays on your
            device, what travels the network, and which third parties can see something.
          </p>
          <p>
            &quot;We&quot; means Ghostly&apos;s maintainer, Miguel Medeiros, and its contributors. Using Ghostly is
            also covered by our <A href="/terms">Terms of Service</A>.
          </p>
        </>
      }
    >
      <Section title="What we collect">
        <p>
          Through the apps, nothing. Ghostly has no analytics, no telemetry, no crash reports and no usage statistics.
          You are never asked for an email address, a phone number, a username or a password.
        </p>
        <p>
          The only data about you that reaches a computer of ours is what any web server receives when you visit it,
          described next.
        </p>
      </Section>

      <Section title="This website">
        <p>ghostly.tools sets no cookies. It runs no analytics, no trackers, no ads and no third-party scripts.</p>
        <ul className="list-disc pl-6 space-y-3">
          <li>
            <Term>Fonts and images</Term> come from this site itself, not from a font or image service.
          </li>
          <li>
            <Term>Your browser&apos;s storage.</Term> The site keeps two small notes in your browser, and never sends
            them anywhere: which sections of the WISP reader you opened (<Code>ghostly.reader.groups</Code>), and
            whether you chose to open invitations in the Ghostly app (<Code>ghostly.join.open</Code>).
          </li>
          <li>
            <Term>Invitations.</Term> An invitation link keeps its code after the <Code>#</Code> of the address. Your
            browser never sends that part to a server, and the page removes it from the address bar as soon as it
            loads.
          </li>
          <li>
            <Term>Downloads.</Term> The download buttons take you to GitHub or the Chrome Web Store, which have their
            own privacy policies. To show the latest version, our server asks GitHub at most once an hour. Your
            browser does not.
          </li>
        </ul>
      </Section>

      <Section title="Hosting and server logs">
        <p>
          ghostly.tools and app.ghostly.tools run on a server of the maintainer&apos;s, reached through Cloudflare.
        </p>
        <ul className="list-disc pl-6 space-y-3">
          <li>
            <Term>Cloudflare</Term> carries every request to both sites. It sees your IP address, the address you
            ask for, your browser&apos;s user agent and the page that linked you, and handles them under its own
            privacy policy. Its answers ask your browser to report failed connections to Cloudflare (Network Error
            Logging). Cloudflare may also show its own check page to traffic it thinks is automated.
          </li>
          <li>
            <Term>ghostly.tools</Term> keeps no log of requests.
          </li>
          <li>
            <Term>app.ghostly.tools</Term> keeps a standard web server log of each request: your IP address, the
            time, the file asked for, the response, the page that linked you and your browser&apos;s user agent. The
            part of an address after <Code>#</Code>, where invitations and sign-in answers travel, is never sent, so
            it is never logged. We use this log only to run and fix the site, never to profile anyone, and it is
            erased when the web app is redeployed.
          </li>
          <li>
            <Term>What the apps ask our sites.</Term> A web app tab asks app.ghostly.tools for{" "}
            <Code>/version.json</Code> when it opens, every four hours and when it comes back to the foreground, to
            offer a new version. A browser extension installed outside the Chrome Web Store asks ghostly.tools for{" "}
            <Code>/latest.json</Code>. The desktop app asks GitHub for new releases. Settings, Updates turns these
            checks off.
          </li>
        </ul>
      </Section>

      <Section title="What stays on your device">
        <p>
          Your keys are made on your device and never leave it. Your contacts, settings, wallets and message history
          live in the app&apos;s own storage on your device: the browser&apos;s, the extension&apos;s or the desktop
          app&apos;s. None of it is synced anywhere.
        </p>
        <p>
          A backup exists only when you make one: a file sealed with your passphrase, which you keep, or the same
          sealed file in an S3-compatible bucket of your own. Uninstalling the app, or clearing the site data, erases
          everything else. We hold no copy and cannot recover it for you.
        </p>
      </Section>

      <Section title="What travels the network">
        <p>
          Ghostly is peer to peer, but peers still have to find each other. Three things leave your device:
        </p>
        <ul className="list-disc pl-6 space-y-3">
          <li>
            <Term>Discovery records on the Mainline DHT.</Term> To be reachable, your app publishes small signed
            records to a public distributed hash table, under keys that belong to each chat. What matters inside them
            is sealed: only the other side of that chat can read it.
          </li>
          <li>
            <Term>Short texts over the DHT.</Term> When no direct connection is up, short texts travel through the
            DHT, sealed, and expire after about five minutes. Only the other side of the chat can read them. The DHT is
            a public network of independent nodes, not a service we run. If you both turn it on for a chat, a message
            for a contact who is away can also wait up to seven days, sealed, in the sender&apos;s own S3 bucket.
          </li>
          <li>
            <Term>Direct connections.</Term> Chats, calls, screen sharing, files and payment messages run directly
            between the two devices over WebRTC, Iroh or HyperDHT, each encrypted end to end by its transport (DTLS,
            QUIC with TLS, or Noise). When no direct path exists, a relay can carry the encrypted traffic without
            being able to read it.
          </li>
        </ul>
      </Section>

      <Section title="Third parties that can see something">
        <p>
          &quot;Peer to peer&quot; does not mean nobody sees anything. Making a connection, and some features you
          choose to use, show your IP address to some parties. None of them is run by us.
        </p>
        <ul className="list-disc pl-6 space-y-3">
          <li>
            <Term>The contacts you talk to.</Term> A direct connection means the person on the other end sees your IP
            address. Connect only with people you are willing to show it to. They also see everything you send them.
            While you write in a one-to-one chat, your app tells that contact you are typing or recording, over the
            live connection only. You can turn this off in Settings, Security.
          </li>
          <li>
            <Term>STUN servers.</Term> To set up a direct connection through a router, WebRTC asks public STUN
            servers, by default Google&apos;s (<Code>stun.l.google.com</Code> and its numbered siblings). They see your
            IP address, never message content. You can add your own TURN server in Settings.
          </li>
          <li>
            <Term>Pkarr relays.</Term> A browser cannot reach the DHT directly, so it publishes and looks up records
            through public relays at <Code>pkarr.pubky.app</Code> and <Code>pkarr.pubky.org</Code>. Ghostly Desktop
            reads the DHT directly and publishes to those relays too. The relays see your IP address and the keys you
            publish or look up. Records are signed, and what matters in them is sealed.
          </li>
          <li>
            <Term>Iroh relays.</Term> In the browser and the extension, Iroh connects through n0&apos;s public relays
            (<Code>relay.n0.iroh.link</Code>) when WebRTC cannot connect. A relay sees your IP address, when you
            connect and how much you send, never the content. You can set your own relays in Settings.
          </li>
          <li>
            <Term>Wake-up push.</Term> If you turn on Settings, Notifications, Wake me while closed, a contact&apos;s
            app can wake yours through your browser&apos;s push service (Google, Apple or Mozilla). The push carries no
            message, name or chat. The push service learns that your browser got a push, and when.
          </li>
          <li>
            <Term>Link previews.</Term> When you send a link, your app reads that page to make its preview, so that
            site sees your IP address. Your contact&apos;s app does not contact it: the preview travels inside the
            message. You can turn link previews off in Settings, Security.
          </li>
          <li>
            <Term>Identities and public profiles.</Term> Checking an identity someone shared, or showing its public
            profile, asks the service behind it, such as Nostr relays, Pubky&apos;s servers, Bluesky&apos;s public API,
            GitHub or GitLab, keys.openpgp.org, or a DNS-over-HTTPS resolver (Quad9 by default) for a domain. They see your IP address and which
            identity is looked up. Public profiles can be turned off in Settings, Security. Some proofs you make are
            public by nature, such as a DNS record, a file on your website or a post on your Bluesky account: you
            publish them, and anyone can read them.
          </li>
          <li>
            <Term>GIFs, pictures and maps.</Term> Ghostly&apos;s GIF search and its GIFs come from the Internet
            Archive (<Code>gifcities.archive.org</Code>, <Code>web.archive.org</Code>). A GIF or picture link shown in
            a chat loads from where it lives, so that site sees the IP address of whoever loads it, sender and
            receiver. A location card loads its map from OpenStreetMap only when you tap it.
          </li>
          <li>
            <Term>Wallets.</Term> A wallet talks to the services it runs on: a Cashu mint, a Fedimint federation, an
            Ark server, a Lightning node or wallet you connect, a Bitcoin node or block explorer, an Ethereum service,
            or a test faucet on Testnet. They see your IP address and the operations they serve. Some of them hold your
            funds. A new profile has no wallet until you create one.
          </li>
          <li>
            <Term>Storage you set up.</Term> A backup or held messages in an S3-compatible bucket go to the provider
            you chose, sealed. That provider sees your IP address and the size and timing of what is stored.
          </li>
        </ul>
        <p>
          None of these parties receives your keys. Apart from the contacts you write to, none of them can read your
          messages.
        </p>
      </Section>

      <Section title="The debugger permission">
        <p>
          The browser extension declares Chrome&apos;s <Code>debugger</Code> permission. It is a powerful permission,
          and it deserves a plain explanation.
        </p>
        <p>
          Ghostly lets a contact open a web app you are running on your own machine. To deliver that app into a tab,
          the extension attaches the debugger to that specific tab, intercepts its requests, and answers them with
          content relayed from the peer over the chat&apos;s live connection. It is the only way a Chrome extension
          can serve a response body to a navigation request.
        </p>
        <p>
          The attach is limited to loopback origins (<Code>localhost</Code>, <Code>127.0.0.1</Code> and{" "}
          <Code>::1</Code>) and happens only for a service you chose to open. The extension does not attach to other
          tabs, does not read the pages you browse, and asks for no access to public websites. No page content is
          collected or sent anywhere.
        </p>
        <p>
          Content served this way comes from your contact&apos;s machine and runs in the page&apos;s own sandboxed
          context, never in the extension&apos;s. Open a shared service only from someone you trust, as you would only
          run software from someone you trust.
        </p>
      </Section>

      <Section title="No selling, no ads">
        <p>
          We do not sell, rent or share data about you, and there are no ads in Ghostly or on our sites. We have no
          such data to begin with.
        </p>
      </Section>

      <Section title="Children">
        <p>
          Ghostly is not made for children under 13. We knowingly collect no information from anyone, of any age, and
          we have no way to tell who uses Ghostly.
        </p>
      </Section>

      <Section title="Changes">
        <p>
          If this policy changes, the new version is published on this page with a new date above, and the change is
          noted in the project&apos;s changelog.
        </p>
      </Section>

      <Section title="Contact">
        <p>
          Ghostly is open source under the MIT License, and all of its code is open for anyone to check. Questions and
          corrections go to the project&apos;s <A href={ISSUES_URL}>issues on GitHub</A>. Report a security problem
          privately, as our <A href={SECURITY_URL}>security policy</A> explains. If something on this page is not true
          of the code, that is a bug, and we want to hear about it.
        </p>
      </Section>
    </LegalPage>
  );
}
