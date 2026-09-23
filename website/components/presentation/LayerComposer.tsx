"use client";

import { useState } from "react";
import Link from "next/link";
import { wisps } from "@/lib/catalog";
import { referencePath } from "@/lib/references";
import { Icon } from "../icons";

type Example = "web" | "native" | "sats" | "group";
type Piece = {
  id: string;
  title: string;
  caption: string;
  detail: string;
  draft?: string;
  proposed?: boolean;
};
const examples: {
  id: Example;
  title: string;
  description: string;
  icon: "chat" | "file" | "bolt" | "globe";
}[] = [
  {
    id: "web",
    title: "Browser chat",
    description: "Current paired profile",
    icon: "chat",
  },
  {
    id: "native",
    title: "Native connection",
    description: "Locally validated adapters",
    icon: "file",
  },
  {
    id: "sats",
    title: "Send sats",
    description: "Current Cashu flow",
    icon: "bolt",
  },
  {
    id: "group",
    title: "Private group",
    description: "Proposed composition",
    icon: "globe",
  },
];
const transports: Piece[] = [
  {
    id: "webrtc",
    title: "WebRTC",
    caption: "Browser · extension · supported native",
    detail:
      "The current browser and extension paired clients advertise WebRTC. The product’s first pairing uses it even when a later native reconnect will use another adapter. Media is a separate capability, not automatically included.",
    draft: "101",
  },
  {
    id: "iroh",
    title: "Iroh",
    caption: "Native adapter",
    detail:
      "Native Iroh binds Ghostly participation to the actual endpoint and QUIC connection. Locally validated in the macOS arm64 bundle. Switching is an authenticated reconnect, not live migration of an in-flight stream.",
    draft: "102",
  },
  {
    id: "hyperdht",
    title: "HyperDHT",
    caption: "Native · Holepunch",
    detail:
      "A bundled native runtime supplies HyperDHT discovery and a Noise stream. The browser does not advertise this adapter. Locally tested using the same Ghostly core, not an independent WISP implementation.",
    draft: "103",
  },
];
const paymentCandidates: Piece[] = [
  {
    id: "ark",
    title: "Ark",
    caption: "Arkade or Bark · choice open",
    detail:
      "A proposed second payment implementation. Compare Arkade and Bark before selecting a profile; neither is an integrated Ghostly payment adapter. Settlement, fees, backup and exit/recovery evidence are required.",
    proposed: true,
  },
  {
    id: "tether",
    title: "Tether · WDK",
    caption: "USDT candidate · not integrated",
    detail:
      "Tether WDK is a research route for a possible USDT wallet adapter. No Ghostly integration is available. A specific asset/network, fees, signer permissions, custody model and recovery behavior must be selected and tested.",
    proposed: true,
  },
];
export function LayerComposer() {
  const [example, setExample] = useState<Example>("web");
  const [transport, setTransport] = useState("webrtc");
  const [inspected, setInspected] = useState("capability");
  const group = example === "group";
  const native = example === "native";
  const sats = example === "sats";
  const pieces: Piece[] = [
    {
      id: "experience",
      title: group
        ? "Private community"
        : sats
          ? "A thank-you in chat"
          : native
            ? "One conversation, another path"
            : "A private conversation",
      caption: group ? "Future experience" : "Reference app",
      detail: group
        ? "A proposed experience built from membership, messaging and distribution. No group client or Ghostly GossipSub adapter is implemented today."
        : "The Ghostly app composes negotiated capabilities into a familiar conversation. This is a local implementation example; public builds and older peers can support less.",
      proposed: group,
    },
    {
      id: "capability",
      title: group
        ? "Group session + chat"
        : sats
          ? "payments/1"
          : "chat/1 + files/2",
      caption: "What both peers agree to do",
      detail: group
        ? "Membership, admission, roles and epochs must be defined before a distribution adapter makes a useful private group. Draft 900 does not require every group to use GossipSub."
        : sats
          ? "Both peers must advertise payments/1 before payment frames are admitted. Agreement on a capability never authorizes spending. Current Cashu rules still apply; generic rails remain proposed."
          : "Peers negotiate supported abilities. files/2 requires support at both ends, bounds each file to 100 MiB and verifies integrity before acknowledging persisted receipt.",
      draft: group ? "900" : sats ? "200" : "500",
      proposed: group,
    },
    {
      id: "contract",
      title: group ? "Membership & admission" : "Authenticated agreement",
      caption: group
        ? "Draft group contract"
        : "Offers · peer pins · channel binding",
      detail: group
        ? "Drafts 800 and 900 sketch invitations and admission, membership changes and group negotiation. Removal, partitions and recovery need evidence before release."
        : "Ghostly signs and verifies participation and negotiated offers against the actual channel. Transport preference, selected adapter and negotiated fallback remain distinct. Contracts define boundaries; implementations must prove them.",
      draft: group ? "800" : "03",
      proposed: group,
    },
    ...(sats
      ? [
          {
            id: "wallet",
            title: "Cashu wallet",
            caption: "Lightning invoices in / out",
            detail:
              "The current application integrates Cashu and invoice flows through a mint. Mints hold funds. Cashu is a payment implementation, not a transport; Lightning invoices do not imply LND, NWC or every wallet provider is integrated.",
            draft: "201",
          },
        ]
      : []),
    {
      id: "discovery",
      title: group ? "Group bootstrap" : "Ghost · Pkarr",
      caption: group
        ? "Profile to be selected"
        : "Small signed discovery records",
      detail: group
        ? "A complete group profile still needs a bootstrap and distribution design. Existing 1:1 discovery is not evidence that a private group network already works."
        : "Small Pkarr records help endpoints find each other. This is a rendezvous primitive, not a general file store. Network expiry, short-message acceptance windows and local history are separate lifecycles.",
      draft: "01",
      proposed: group,
    },
  ];
  const transportPiece: Piece = group
    ? {
        id: "gossipsub",
        title: "GossipSub",
        caption: "Optional distribution candidate",
        detail:
          "Draft 22 proposes an optional group distribution adapter. A common stack, authenticated group envelopes, abuse bounds and churn tests must be selected and validated. It does not provide durable history by itself.",
        draft: "901",
        proposed: true,
      }
    : transports.find((t) => t.id === transport)!;
  const selected =
    [...pieces, transportPiece, ...paymentCandidates].find(
      (p) => p.id === inspected,
    ) ?? pieces[1];
  function chooseExample(next: Example) {
    setExample(next);
    setTransport(next === "native" ? "iroh" : "webrtc");
    setInspected("capability");
  }
  function block(piece: Piece) {
    return (
      <button
        key={piece.id}
        type="button"
        className={`layer-piece ${piece.proposed ? "proposed" : ""}`}
        aria-pressed={selected.id === piece.id}
        onClick={() => setInspected(piece.id)}
      >
        <span className="layer-studs" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <strong>{piece.title}</strong>
        <small>{piece.caption}</small>
        {piece.proposed && (
          <span className="layer-proposed-label">Proposed</span>
        )}
      </button>
    );
  }
  return (
    <section
      className="p-wrap layer-composer"
      id="architecture"
      aria-labelledby="layers-title"
    >
      <div className="layer-heading">
        <div>
          <p className="p-eyebrow">EXPLORE THE ARCHITECTURE</p>
          <h2 id="layers-title">
            Different pieces.
            <br />
            <em>One shared agreement.</em>
          </h2>
        </div>
        <p>
          Pick a use case. Follow the connections.
          <br />
          Select a piece to inspect its contract.
        </p>
      </div>
      <div
        className="layer-examples"
        role="group"
        aria-label="Composition examples"
      >
        {examples.map((e) => (
          <button
            key={e.id}
            type="button"
            aria-pressed={example === e.id}
            onClick={() => chooseExample(e.id)}
          >
            <Icon name={e.icon} />
            <span>
              <strong>{e.title}</strong>
              <small>{e.description}</small>
            </span>
          </button>
        ))}
      </div>
      <div className="layer-workbench" data-proposed={group}>
        <div className="layer-map" aria-label="Connected architecture layers">
          <div className="layer-row">
            <div className="layer-label">
              <span>01</span>Experience
            </div>
            <div className="layer-pieces">{block(pieces[0])}</div>
          </div>
          <div className="layer-row">
            <div className="layer-label">
              <span>02</span>Capabilities
            </div>
            <div className="layer-pieces">{block(pieces[1])}</div>
          </div>
          <div className="layer-row">
            <div className="layer-label">
              <span>03</span>Coordination
            </div>
            <div className="layer-pieces">
              {block(pieces[2])}
              {sats && block(pieces[3])}
            </div>
          </div>
          <div className="layer-row">
            <div className="layer-label">
              <span>04</span>
              {group ? "Distribution" : "Transport"}
            </div>
            <div className="layer-pieces layer-transports">
              {group
                ? block(transportPiece)
                : transports.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      className={`layer-piece ${transport === t.id ? "connected" : ""}`}
                      disabled={!native && t.id !== "webrtc"}
                      aria-pressed={transport === t.id}
                      onClick={() => {
                        setTransport(t.id);
                        setInspected(t.id);
                      }}
                    >
                      <span className="layer-studs" aria-hidden="true">
                        <i />
                        <i />
                      </span>
                      <strong>{t.title}</strong>
                      <small>
                        {!native && t.id !== "webrtc"
                          ? "Needs native client"
                          : transport === t.id
                            ? "Selected in this example"
                            : "Select adapter"}
                      </small>
                    </button>
                  ))}
            </div>
          </div>
          <div className="layer-row layer-discovery">
            <div className="layer-label">
              <span>05</span>Discovery
            </div>
            <div className="layer-pieces">
              {block(pieces[pieces.length - 1])}
            </div>
          </div>
          {sats && (
            <div className="layer-candidates">
              <p>Future wallet pieces · not connected to this implementation</p>
              <div className="layer-pieces">{paymentCandidates.map(block)}</div>
            </div>
          )}
        </div>
        <aside
          className="layer-inspector"
          aria-label="Selected piece details"
          aria-live="polite"
        >
          <span className={`p-status ${selected.proposed ? "deferred" : ""}`}>
            {selected.proposed
              ? "Proposed · not implemented"
              : "Current implementation · scoped"}
          </span>
          <h3>{selected.title}</h3>
          <p>{selected.detail}</p>
          {selected.draft && (
            <Link
              href={referencePath(
                wisps.find((wisp) => wisp.number === selected.draft)!.file,
              )}
            >
              Inspect Draft {wisps.find((wisp) => wisp.number === selected.draft)?.displayNumber} ↗
            </Link>
          )}
          {!selected.draft && selected.proposed && (
            <Link href="/roadmap">Explore the proposed roadmap ↗</Link>
          )}
          <div className="layer-inspector-note">
            <strong>Contract ≠ implementation</strong>
            <p>
              All WISPs remain Draft candidates. Local tests do not establish
              full independent conformance.
            </p>
          </div>
        </aside>
      </div>
      <p className="p-footnote">
        An architecture illustration, not a live connection or compatibility
        simulator. Lines show responsibilities, not packet routing. Native
        options require supported runtimes; new payment rails and groups remain
        proposals.
      </p>
    </section>
  );
}
