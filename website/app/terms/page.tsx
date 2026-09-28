import type { Metadata } from "next";
import { A, Caps, Code, LICENSE_URL, ISSUES_URL, LegalPage, Section, Term } from "@/components/site/Legal";
import { SECURITY_URL } from "@/content/shell";

const DESCRIPTION =
  "Ghostly is free, open-source software you run on your own device. You hold your keys and your money, and you use it at your own risk. The terms for the apps and the sites.";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: DESCRIPTION,
  alternates: { canonical: "/terms" },
  openGraph: {
    title: "Terms of Service | Ghostly",
    description: DESCRIPTION,
    type: "article",
    url: "https://ghostly.tools/terms",
    images: [{ url: "https://ghostly.tools/og-image.png", width: 1200, height: 630, alt: "Ghostly Terms of Service" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Terms of Service | Ghostly",
    description: DESCRIPTION,
    images: ["https://ghostly.tools/og-image.png"],
  },
};

const LAST_UPDATED = "September 28, 2026";

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of Service"
      updated={LAST_UPDATED}
      lead={
        <>
          <p>
            These terms apply when you use Ghostly: the desktop apps, the browser extension, the web app, the
            command-line tools, and the sites ghostly.tools and app.ghostly.tools. By downloading, installing or using
            any of them, you accept these terms. If you do not accept them, do not use Ghostly.
          </p>
          <p>
            The short version: Ghostly is free software that runs on your device. You hold your keys, your messages
            and your money, and nobody else can recover them for you. It is experimental. You use it at your own risk.
          </p>
        </>
      }
    >
      <Section title="Who we are">
        <p>
          Ghostly is an open-source project maintained by Miguel Medeiros, with contributions from other people. In
          these terms, &quot;we&quot; and &quot;us&quot; mean the maintainer and the contributors. There is no company
          behind Ghostly. You pay us nothing, and we sell you nothing.
        </p>
      </Section>

      <Section title="What Ghostly is">
        <ul className="list-disc pl-6 space-y-3">
          <li>
            <Term>Free, open-source software.</Term> Ghostly is released under the{" "}
            <A href={LICENSE_URL}>MIT License</A>. It runs on your own device: in the desktop app, in the browser
            extension, in a browser tab, or on the command line.
          </li>
          <li>
            <Term>No accounts.</Term> Your keys are made on your device. We never receive them, and we have no
            account, password or profile of yours on any server.
          </li>
          <li>
            <Term>Peer to peer.</Term> Messages, calls, files and payment messages go between your device and the
            people you choose, directly or through independent networks such as the Mainline DHT and public relays.
          </li>
          <li>
            <Term>No custody.</Term> Ghostly&apos;s wallets are software on your device. We never hold, receive, send
            or control your money. We cannot see, reverse, freeze or recover a payment.
          </li>
        </ul>
      </Section>

      <Section title="What we run, and what we do not">
        <p>We run two websites, and nothing else that Ghostly depends on:</p>
        <ul className="list-disc pl-6 space-y-3">
          <li>
            <Term>ghostly.tools</Term> serves this website. It also serves two small public files: the number of the
            latest release (<Code>/latest.json</Code>), and the description that AT Protocol servers, such as Bluesky&apos;s,
            read when you sign in to publish an identity proof (<Code>/oauth/client-metadata.json</Code>).
          </li>
          <li>
            <Term>app.ghostly.tools</Term> serves the files of the web app. Once loaded, the app runs in your browser
            tab. The site never receives your messages, keys, contacts or money.
          </li>
        </ul>
        <p>
          We do not run any relay, DHT node, STUN or TURN server, push service, Cashu mint, Fedimint federation,
          Lightning node, Ark server or storage service. The installers are published on GitHub, and the extension on
          the Chrome Web Store.
        </p>
        <p>
          Anyone may build and host Ghostly. A copy hosted or changed by someone else is theirs, not ours, and these
          terms do not make us responsible for it.
        </p>
      </Section>

      <Section title="Experimental software, provided as is">
        <p>
          Ghostly is under active development and is experimental. It can have bugs, including security flaws, that
          expose data or lose messages, files or money. Features can change or be removed at any time.
        </p>
        <p>
          The Mainnet wallets move real money and are experimental. Some of them have been tested only on test
          networks. Testnet coins are worth nothing and can never be exchanged for money.
        </p>
        <Caps>
          GHOSTLY IS PROVIDED &quot;AS IS&quot; AND &quot;AS AVAILABLE&quot;, WITHOUT WARRANTY OF ANY KIND, EXPRESS
          OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE,
          NON-INFRINGEMENT, SECURITY, ACCURACY AND AVAILABILITY. WE DO NOT WARRANT THAT GHOSTLY WILL WORK WITHOUT
          INTERRUPTION OR ERROR, THAT MESSAGES, FILES OR PAYMENTS WILL BE DELIVERED, OR THAT IT IS FREE OF
          VULNERABILITIES.
        </Caps>
      </Section>

      <Section title="Your responsibility">
        <p>You choose to use Ghostly, and you use it at your own risk. In particular:</p>
        <ul className="list-disc pl-6 space-y-3">
          <li>
            <Term>Your keys and backups are yours alone.</Term> Your keys, seeds, passphrases and backups exist only
            where you keep them. We have no copy. If you lose a device, forget a passphrase, clear your browser&apos;s
            data, uninstall the app or lose a backup, your messages, contacts and money can be lost forever.
          </li>
          <li>
            <Term>You choose who to trust.</Term> You choose the wallets, mints, federations, Lightning nodes and
            services, Ark servers, relays, identity providers and storage you use, and the people you talk to and pay.
            Check them yourself.
          </li>
          <li>
            <Term>Payments are final.</Term> A payment on Bitcoin, Lightning, Cashu, Ark, Fedimint, Spark or Ethereum
            generally cannot be reversed. Check the amount and the person before you confirm. Ghostly asks for a second
            step before any Mainnet payment. Taking that step is your decision.
          </li>
          <li>
            <Term>Start small.</Term> Try a new wallet, network or feature with an amount you can afford to lose.
          </li>
          <li>
            <Term>What you send is yours.</Term> You are responsible for what you send, share or publish, including
            identity proofs you make public and apps you share with a contact. Open a file, a link or a shared app only
            from someone you trust.
          </li>
          <li>
            <Term>Keep your device safe.</Term> Anyone who controls your device, your browser or a web page that
            serves you Ghostly can reach your keys and your money. Keep them secure and up to date.
          </li>
          <li>
            <Term>Follow the law where you live.</Term> This includes laws on communications, money, taxes and
            sanctions. Any taxes or reports on your payments are your responsibility.
          </li>
          <li>
            <Term>Age.</Term> You must be old enough to accept these terms where you live. If you are not, use
            Ghostly only with the consent of a parent or guardian who accepts them for you.
          </li>
        </ul>
      </Section>

      <Section title="Third parties">
        <p>
          Ghostly connects you to services run by others: Cashu mints, Fedimint federations, Lightning nodes and
          wallets (through NWC, LND, Core Lightning, Breez, Spark or WebLN), Ark servers, Bitcoin nodes and block
          explorers, Ethereum services for USDT, Pkarr relays, the Mainline DHT, Iroh and HyperDHT relays, STUN and
          TURN servers, push services, identity providers, DNS resolvers, S3 storage, GitHub and the Chrome Web Store.
        </p>
        <p>
          They are independent of us. We do not control, operate, endorse or guarantee any of them, including the ones
          Ghostly offers by default. Their own terms and privacy policies apply. Some of them hold money for you, such
          as a mint, a federation or a hosted Lightning wallet. If one of them fails, closes or refuses to pay, that
          money can be lost, and we cannot get it back.
        </p>
      </Section>

      <Section title="Limitation of liability">
        <Caps>
          TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT SHALL WE BE LIABLE FOR ANY CLAIM, DAMAGES OR
          OTHER LIABILITY, WHETHER IN CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH GHOSTLY,
          ITS USE OR THESE TERMS.
        </Caps>
        <p>This includes, without limit:</p>
        <ul className="list-disc pl-6 space-y-2">
          <li>lost, stolen or frozen funds, coins, tokens or ecash;</li>
          <li>lost keys, seeds, passphrases, backups, messages, files or other data;</li>
          <li>payments that fail, are delayed, are sent twice or go to the wrong person;</li>
          <li>what any third party, contact or network does or fails to do;</li>
          <li>bugs, security flaws, attacks and outages;</li>
          <li>lost profits, revenue, business or opportunity;</li>
          <li>any indirect, incidental, special, consequential, exemplary or punitive damages,</li>
        </ul>
        <p>even if we were told such damages were possible.</p>
        <p>
          If, despite this, we are found liable, our total liability is limited to what you paid us for Ghostly, which
          is nothing, or, where the law requires more, to the lowest amount the law allows. Some places do not allow
          some of these limits. There, they apply as far as the law allows.
        </p>
      </Section>

      <Section title="Indemnity">
        <p>
          You agree to defend, indemnify and hold us harmless from any claim, loss, liability or expense, including
          reasonable legal fees, that comes from your use or misuse of Ghostly, your breach of these terms or of any
          law, or your violation of someone else&apos;s rights.
        </p>
      </Section>

      <Section title="Acceptable use">
        <p>
          Do not use Ghostly for anything illegal or harmful. That includes fraud, money laundering, financing
          terrorism, evading sanctions, abusing or exploiting children, harassing or threatening people, spreading
          malware, infringing others&apos; rights, or attacking our sites or other people&apos;s devices.
        </p>
        <p>
          Ghostly has no accounts and no central server, so we cannot see, moderate or remove what people send to
          each other. If someone misuses Ghostly against you, stop talking to them and, where it is right to, contact
          the authorities.
        </p>
        <p>
          Security research done in good faith under our <A href={SECURITY_URL}>security policy</A> is welcome.
        </p>
      </Section>

      <Section title="No guarantee of availability">
        <p>
          Our sites can change, go offline or close at any time, without notice. We have no duty to maintain, update
          or support Ghostly, to fix a bug, or to keep any feature, default service or release available.
        </p>
      </Section>

      <Section title="The open-source license">
        <p>
          The code is licensed under the <A href={LICENSE_URL}>MIT License</A>. Nothing in these terms takes away a
          right that license gives you over the code. These terms cover your use of Ghostly as we release it and of
          our sites. Where the license and these terms both disclaim warranties or liability, both apply.
        </p>
      </Section>

      <Section title="Changes to these terms">
        <p>
          We may change these terms. The new version is published on this page with a new date above. Using Ghostly
          after a change means you accept the new terms.
        </p>
      </Section>

      <Section title="General">
        <p>
          These terms are governed by the laws of Brazil. If a part of them cannot be enforced, the rest still
          applies. If we do not enforce a part of them, we have not given it up. These terms and our{" "}
          <A href="/privacy">Privacy Policy</A> are the whole agreement between you and us about Ghostly.
        </p>
      </Section>

      <Section title="Contact">
        <p>
          Questions about these terms go to the project&apos;s <A href={ISSUES_URL}>issues on GitHub</A>. Report a
          security problem privately, as our <A href={SECURITY_URL}>security policy</A> explains, never in a public
          issue.
        </p>
      </Section>
    </LegalPage>
  );
}
