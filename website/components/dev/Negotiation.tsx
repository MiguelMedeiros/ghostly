"use client";

import { useMemo, useState } from "react";
import { Ghost } from "@/components/ghost/Ghost";
import type { DevCopy } from "@/content/developers";

const TRANSPORTS = ["iroh/1", "hyperdht/1", "webrtc/1"] as const;
type T = (typeof TRANSPORTS)[number];
type Platform = "desktop" | "browser" | "extension";
const AVAILABLE: Record<Platform, T[]> = {
  desktop: ["iroh/1", "hyperdht/1", "webrtc/1"],
  browser: ["webrtc/1"],
  extension: ["webrtc/1"],
};
const CAPS = ["chat/1", "files/2", "payments-cashu/1", "payments-lightning/1", "payments-arkade/1", "payments-usdt/1"];

type Peer = { platform: Platform; preferred: T; caps: string[]; fallback: boolean };

// Same rule as packages/core/src/pairedTransports.ts: symmetric rank sum,
// ties broken by the fixed order.
function rank(local: readonly string[], remote: readonly string[]) {
  return TRANSPORTS.filter((t) => local.includes(t) && remote.includes(t)).sort(
    (a, b) => local.indexOf(a) + remote.indexOf(a) - (local.indexOf(b) + remote.indexOf(b)) || TRANSPORTS.indexOf(a) - TRANSPORTS.indexOf(b),
  );
}
// What a peer offers (transportOrder in the same file): its preferred adapter
// first, then the others it has in the fixed order, only when fallback is on.
function offered(p: Peer): T[] {
  const avail = AVAILABLE[p.platform];
  const rest = TRANSPORTS.filter((t) => avail.includes(t) && t !== p.preferred);
  return [...(avail.includes(p.preferred) ? [p.preferred] : []), ...(p.fallback ? rest : [])];
}

const SCENARIOS: Record<string, [Peer, Peer]> = {
  match: [
    { platform: "desktop", preferred: "iroh/1", caps: CAPS.slice(0, 5), fallback: true },
    { platform: "desktop", preferred: "hyperdht/1", caps: CAPS.slice(0, 5), fallback: true },
  ],
  browser: [
    { platform: "desktop", preferred: "iroh/1", caps: CAPS.slice(0, 5), fallback: true },
    { platform: "browser", preferred: "webrtc/1", caps: ["chat/1", "files/2", "payments-cashu/1"], fallback: true },
  ],
  none: [
    { platform: "desktop", preferred: "iroh/1", caps: ["chat/1", "files/2"], fallback: false },
    { platform: "browser", preferred: "webrtc/1", caps: ["chat/1", "files/2"], fallback: true },
  ],
  partial: [
    { platform: "browser", preferred: "webrtc/1", caps: ["chat/1", "files/2", "payments-cashu/1", "payments-arkade/1"], fallback: true },
    { platform: "extension", preferred: "webrtc/1", caps: ["chat/1", "files/2"], fallback: true },
  ],
};

function PeerCard({ who, peer, set, t }: { who: "boo" | "casper"; peer: Peer; set: (p: Peer) => void; t: DevCopy["negotiate"] }) {
  const toggle = (c: string) => set({ ...peer, caps: peer.caps.includes(c) ? peer.caps.filter((x) => x !== c) : [...peer.caps, c] });
  const name = who === "boo" ? t.boo : t.casper;
  const offer = offered(peer);
  const setPlatform = (platform: Platform) =>
    set({ ...peer, platform, preferred: AVAILABLE[platform].includes(peer.preferred) ? peer.preferred : AVAILABLE[platform][0] });
  return (
    <fieldset className="peer" data-who={who}>
      <legend>
        <Ghost who={who} size={40} float={false} mood="calm" /> {name}
      </legend>
      <label className="peer-field">
        <span>{t.platform}</span>
        <select value={peer.platform} onChange={(e) => setPlatform(e.target.value as Platform)}>
          {(Object.keys(t.platforms) as Platform[]).map((p) => (
            <option key={p} value={p}>
              {t.platforms[p]}
            </option>
          ))}
        </select>
      </label>
      <label className="peer-field">
        <span>{t.preferred}</span>
        <select value={peer.preferred} onChange={(e) => set({ ...peer, preferred: e.target.value as T })}>
          {TRANSPORTS.map((tr) => (
            <option key={tr} value={tr} disabled={!AVAILABLE[peer.platform].includes(tr)}>
              {tr}
              {AVAILABLE[peer.platform].includes(tr) ? "" : ` — ${t.unavailable}`}
            </option>
          ))}
        </select>
      </label>
      <label className="peer-check">
        <input type="checkbox" checked={peer.fallback} onChange={(e) => set({ ...peer, fallback: e.target.checked })} /> {t.fallback}
      </label>
      <div className="peer-field">
        <span>{t.transports}</span>
        <ol className="peer-order">
          {offer.map((tr) => (
            <li key={tr}>
              <span className="mono">{tr}</span>
            </li>
          ))}
        </ol>
      </div>
      <div className="peer-field">
        <span>{t.capabilities}</span>
        <div className="peer-caps">
          {CAPS.map((c) => (
            <label key={c} className="cap-chip" data-on={peer.caps.includes(c)}>
              <input type="checkbox" checked={peer.caps.includes(c)} onChange={() => toggle(c)} disabled={c === "chat/1"} />
              <span className="mono">{c}</span>
            </label>
          ))}
        </div>
      </div>
    </fieldset>
  );
}

export function Negotiation({ t }: { t: DevCopy["negotiate"] }) {
  const [scenario, setScenario] = useState<keyof typeof SCENARIOS>("browser");
  const [boo, setBoo] = useState<Peer>(SCENARIOS.browser[0]);
  const [casper, setCasper] = useState<Peer>(SCENARIOS.browser[1]);

  const pick = (s: keyof typeof SCENARIOS) => {
    setScenario(s);
    setBoo(SCENARIOS[s][0]);
    setCasper(SCENARIOS[s][1]);
  };

  const result = useMemo(() => {
    const a = offered(boo);
    const b = offered(casper);
    const order = rank(a, b);
    const caps = boo.caps.filter((c) => casper.caps.includes(c));
    const off = [...new Set([...boo.caps, ...casper.caps])].filter((c) => !caps.includes(c));
    const payments = caps.some((c) => c.startsWith("payments-")) ? ["payments/1"] : [];
    return { a, order, caps: [...caps.slice(0, 2), ...payments, ...caps.slice(2)], off, limited: !boo.fallback || !casper.fallback };
  }, [boo, casper]);

  const offer = {
    t: "pair-offer",
    versions: [1],
    transports: result.a,
    capabilities: ["chat/1", "signed-signal/1", ...boo.caps.filter((c) => c !== "chat/1"), ...(boo.fallback ? ["transport-fallback/1"] : [])],
  };

  return (
    <div className="nego">
      <div className="nego-scenarios" role="radiogroup" aria-label={t.scenarios}>
        <span className="dim mono">{t.scenarios}</span>
        {(Object.keys(SCENARIOS) as (keyof typeof SCENARIOS)[]).map((s) => (
          <button key={s} role="radio" aria-checked={scenario === s} className="preset" onClick={() => pick(s)}>
            {t.scenarioNames[s as keyof typeof t.scenarioNames]}
          </button>
        ))}
      </div>
      <div className="nego-grid">
        <PeerCard who="boo" peer={boo} set={setBoo} t={t} />
        <div className="nego-result" aria-live="polite">
          <h3 className="mono">{t.result}</h3>
          {result.order.length ? (
            <>
              <p className="nego-ok">{t.agreed}</p>
              <div className="nego-chips">
                {result.caps.map((c) => (
                  <span key={c} className="cap-chip" data-on="true">
                    <span className="mono">{c}</span>
                  </span>
                ))}
              </div>
              <p className="nego-label">{t.order}</p>
              <ol className="nego-order">
                {result.order.map((tr, i) => (
                  <li key={tr} data-first={i === 0}>
                    <span className="mono">{tr}</span>
                  </li>
                ))}
              </ol>
              {result.limited && <p className="dim nego-small">{t.noFallback}</p>}
              {result.off.length > 0 && (
                <>
                  <p className="nego-label">{t.off}</p>
                  <div className="nego-chips">
                    {result.off.map((c) => (
                      <span key={c} className="cap-chip">
                        <span className="mono">{c}</span>
                      </span>
                    ))}
                  </div>
                </>
              )}
            </>
          ) : (
            <p className="nego-fail">{t.fail}</p>
          )}
        </div>
        <PeerCard who="casper" peer={casper} set={setCasper} t={t} />
      </div>
      <details className="nego-offer">
        <summary>{t.offer}</summary>
        <pre>
          <code>{JSON.stringify(offer, null, 2)}</code>
        </pre>
      </details>
      <p className="dim nego-small">{t.note}</p>
    </div>
  );
}
