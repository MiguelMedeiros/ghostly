import type { Metadata } from "next";
import Link from "next/link";
import { Shell, Eyebrow } from "@/components/presentation/Shell";
export const metadata: Metadata = {
  title: "Public roadmap",
  description:
    "The outcomes Ghostly is exploring: payments, optional identities, social experiences, durable services and independent apps. Clear scope, dependencies and evidence gates.",
  alternates: { canonical: "/roadmap" },
};
const phases = [
  {
    n: "01",
    state: "Local implementation",
    title: "Make the foundation tangible.",
    body: "Reference chat, negotiated files and sats, and supported data adapters. A new site and catalogue to explain how those pieces fit.",
    gate: "Website review, accurate client/profile scope, accessible navigation and reproducible evidence. This preview is not a public release.",
  },
  {
    n: "02",
    state: "Proposed next scope",
    title: "One payment agreement. More choice.",
    body: "Demonstrate a reusable payment contract with Cashu and a selected second implementation. Compare Arkade and Bark before choosing; begin backup and recovery here.",
    gate: "Disposable-network settlement, fee limits, unknown-result reconciliation and restore/exit tests. A candidate is not yet an integration commitment.",
  },
  {
    n: "03",
    state: "Proposed direction",
    title: "Bring an identity. Only if you want.",
    body: "Optional external proofs through supported signers, without requiring a public account. Keep profiles, social graphs, reading feeds and publishing content separate.",
    gate: "No-proof sessions still work. Validate selective binding, revocation, source attribution and signer permissions before enabling deferred integrations.",
  },
  {
    n: "04",
    state: "Proposed direction",
    title: "From a conversation to a community.",
    body: "Private groups, roles and shared experiences. Explore social apps built on explicit membership and capabilities.",
    gate: "Choose membership authority, epochs and a common distribution profile. Test removal, partitions, abuse bounds and recovery.",
  },
  {
    n: "05",
    state: "Long-term direction",
    title: "Let useful things stay around.",
    body: "Durable services, storage and portable data. Plugins and independent apps that can run beyond a single open tab.",
    gate: "Restoration drills, a permissioned plugin host, malicious-plugin tests, package provenance and update policy.",
  },
  {
    n: "06",
    state: "Long-term direction",
    title: "An ecosystem you can host.",
    body: "Independent catalogues, optional paid apps and a self-hosted GhostlyOS runtime. A small always-on device is one possible home.",
    gate: "Measured host requirements, secure administration, backup, reboot and upgrade tests. No OS, catalogue marketplace or promised release date today.",
  },
];
const explorations = [
  [
    "Connections & delivery",
    "Reach each other in more conditions.",
    "Tor, opt-in LAN discovery, generic QUIC, libp2p and WebSocket profiles; relays, store-and-forward, bridges and multi-hop routing. Pear, Hypercore and Autobase are research components. Offline delivery needs its own receipts, retention and recovery semantics.",
  ],
  [
    "Payment rails",
    "Choose how value travels.",
    "Bitcoin on-chain, Ark (Arkade or Bark), Fedimint, Spark, Liquid and USDT are candidates beyond the existing Cashu/Lightning flow. Each needs an exact asset, network, fee, trust and recovery model. Arkade and Bark compatibility is not assumed.",
  ],
  [
    "Wallets, providers & chain data",
    "Use your own tools without confusing their roles.",
    "LND, Core Lightning, NWC and WebLN are possible wallet/provider routes. Bitcoin Core, Electrum, Esplora, BDK and PSBT serve different observation, construction, signing or broadcast roles. A chain source cannot authorize a spend.",
  ],
  [
    "Identity & social data",
    "Let people bring context, selectively.",
    "Nostr, Pubky, Keet, PGP, SSH, Bitcoin/BIP322, DID, Farcaster, AT Protocol/Bluesky, SSB, ActivityPub/Mastodon and GitHub. All external Ghostly proofs are deferred. Account proof, profile, graph, feed reads and publication require separate permissions and evidence.",
  ],
  [
    "Signers & hardware",
    "Keep authority with the person holding the key.",
    "Trezor and YubiKey; Ledger, COLDCARD and Jade as additional research candidates. Transaction signing, arbitrary messages and identity proofs are different operations. Device/firmware support must be demonstrated; plugins must never receive wallet secrets.",
  ],
  [
    "Groups, media & data",
    "Give shared spaces a reliable memory.",
    "Admission, roles, epochs, group chat, channels and forums; media, file distribution, local and remote storage, backup and migration. GossipSub, MLS and IPFS are candidate building blocks, not an adopted universal stack.",
  ],
  [
    "Apps, catalogues & GhostlyOS",
    "Make room for things others build.",
    "A plugin SDK, scoped manifests, sandboxing, mini-apps and games; independent indexes, provenance, reputation and optional paid distribution. WASI, TUF, Automerge, Raspberry Pi and Umbrel are research routes. A working catalogue or OS is not implemented.",
  ],
];
export default function Roadmap() {
  return (
    <Shell active="roadmap">
      <section className="p-wrap p-page-top">
        <Eyebrow>PUBLIC ROADMAP · REVIEWED 22 SEP 2026</Eyebrow>
        <h1>
          A small beginning.
          <br />
          <em>An open horizon.</em>
        </h1>
        <p className="p-lead">
          More possibilities through shared agreements.
          <br />
          Progress measured in working connections, not logos.
        </p>
        <div className="p-notice">
          This is a proposed sequence, not a delivery calendar. Candidates are
          exploration until a bounded scope and acceptance evidence are agreed.{" "}
          <Link href="/developers#availability">
            See what works locally today ↗
          </Link>
        </div>
        <div className="p-roadmap">
          {phases.map((p) => (
            <article key={p.n}>
              <div className="p-roadmap-index">{p.n}</div>
              <div>
                <span className="p-status">{p.state}</span>
                <h2>{p.title}</h2>
                <p>{p.body}</p>
                <details>
                  <summary>
                    What unlocks the next step? <span>+</span>
                  </summary>
                  <p>{p.gate}</p>
                </details>
              </div>
            </article>
          ))}
        </div>
      </section>
      <section className="p-quiet">
        <div className="p-wrap">
          <Eyebrow>THE EXPLORATION MAP</Eyebrow>
          <h2>
            More ways to do
            <br />
            <em>something useful.</em>
          </h2>
          <p className="p-lead">
            These are candidate families, not functioning Ghostly integrations.
          </p>
          <div className="p-explorations">
            {explorations.map(([title, outcome, body]) => (
              <details key={title}>
                <summary>
                  <span>
                    <strong>{title}</strong>
                    <small>{outcome}</small>
                  </span>
                  <span>+</span>
                </summary>
                <p>{body}</p>
              </details>
            ))}
          </div>
          <div className="p-banner">
            <p>Read the dependencies, source review and open decisions.</p>
            <a
              className="p-button secondary"
              href="/developers/wisps/adapter-roadmap"
            >
              Full research roadmap ↗
            </a>
          </div>
        </div>
      </section>
      <section className="p-section p-wrap">
        <Eyebrow>HOW AN IDEA BECOMES A RELEASE</Eyebrow>
        <h2>
          Explore. Implement.
          <br />
          <em>Verify. Maintain.</em>
        </h2>
        <p className="p-lead">
          An upstream SDK is the beginning of research. It becomes a Ghostly
          capability only after an adapter, an agreed profile, interoperability
          and platform evidence.
        </p>
        <div className="p-actions">
          <Link className="p-button" href="/developers">
            Build a piece of it ↗
          </Link>
          <Link className="p-text-link" href="/developers/catalog">
            Inspect the contracts ↗
          </Link>
        </div>
      </section>
    </Shell>
  );
}
