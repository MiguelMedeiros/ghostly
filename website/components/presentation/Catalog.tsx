"use client";
import { useEffect, useRef, useState } from "react";
import { referencePath } from "@/lib/references";
import { wisps } from "@/lib/catalog";
import numbering from "@/lib/wisp-numbering.json";
import candidates from "@/lib/roadmap-candidates.json";
import { ReferenceMarkdown } from "./ReferenceMarkdown";

const groups = [
  ["0", "00–99", "Foundations", "Process, discovery, peer keys and common capabilities. These are separate foundations, not transport adapters."],
  ["1", "1xx", "Transports", "100 defines transport negotiation. 101–103 describe the data-path adapters that can satisfy that contract."],
  ["2", "2xx", "Payments", "200 defines payment negotiation. Cashu, experimental Arkade and Lightning describe method integrations; support never authorizes spending."],
  ["3", "3xx", "Identity", "300 defines optional external proofs. Nostr 301 is a disabled experimental binding. Pubky and Keet are planned 3xx proposals with no assigned number."],
  ["4", "4xx", "Chat", "400 defines messaging; 401 paired chat, 402 legacy timestamps and 403 bounded DHT text specify distinct implemented profiles."],
  ["5", "5xx", "Files", "500 defines file-transfer safety; 501 paired files and 502 legacy frames have different receipt guarantees."],
  ["6", "6xx", "Voice & video", "600 defines media coordination; 601 documents existing legacy WebRTC calls. Other data transports do not automatically support media."],
  ["7", "7xx", "Local services", "700 defines local-service authorization; 701 maps the existing HTTP proxy."],
  ["8", "8xx", "Invite & join", "800 defines invitation/admission responsibilities; 801 documents current bearer bootstrap formats, without global single-use guarantees."],
  ["9", "9xx", "Groups", "900 defines proposed group sessions. GossipSub is a planned 9xx distribution proposal, with its number to be defined; no group profile is implemented."],
  ["10", "10xx", "Storage", "1000 defines the storage contract for encrypted bundles; 1001 local files and 1002 S3-compatible buckets are its first adapters. WebDAV and relay storage are planned."],
  ["social", "—", "Profiles & social data", "Profile, graph, feed and publication are separate capabilities with separate permissions. Family numbering is not assigned."],
  ["signers", "—", "Hardware & signers", "Devices and signing services compose with payments or proofs. A signer is not a payment rail; numbering is not assigned."],
  ["storage", "—", "Storage & continuity", "Local persistence, remote storage, backup and offline reconciliation have different trust and retention boundaries. Numbering is not assigned."],
  ["runtime", "—", "Apps, plugins & GhostlyOS", "Runtime, distribution, hosting and product compositions under consideration. These do not automatically require a WISP."],
];
const groupOf = (number: string) => number.length < 3 ? "0" : number.length >= 4 ? number.slice(0, 2) : number[0];
export function Catalog({ bodies }: { bodies: Record<string, string> }) {
  const [query, setQuery] = useState("");
  const [openGroups, setOpenGroups] = useState<string[]>([]);
  const [openDocs, setOpenDocs] = useState<string[]>([]);
  const pendingAnchor = useRef<string | null>(null);
  const toggle = (items: string[], id: string) => items.includes(id) ? items.filter((item) => item !== id) : [...items, id];
  useEffect(() => {
    const reveal = () => {
      const candidate = candidates.find((entry) => `#${entry.id}` === window.location.hash);
      if (candidate) {
        pendingAnchor.current = candidate.id;
        setOpenGroups((items) => [...new Set([...items, candidate.family])]);
        setOpenDocs((items) => [...new Set([...items, candidate.id])]);
        return;
      }
      const match = window.location.hash.match(/^#wisp-(\d+)/);
      if (!match) return;
      const id = wisps.some((w) => w.number === match[1]) ? match[1] : (numbering.find((row) => row.oldId === match[1])?.id ?? match[1]);
      if (!wisps.some((w) => w.number === id)) return;
      pendingAnchor.current = window.location.hash.slice(1);
      setOpenGroups((items) => [...new Set([...items, groupOf(id)])]);
      setOpenDocs((items) => [...new Set([...items, id])]);
    };
    reveal();
    window.addEventListener("hashchange", reveal);
    return () => window.removeEventListener("hashchange", reveal);
  }, []);
  useEffect(() => {
    if (!pendingAnchor.current) return;
    const element = document.getElementById(pendingAnchor.current);
    if (element && element.getClientRects().length) {
      element.scrollIntoView({ block: "start" });
      pendingAnchor.current = null;
    }
  }, [openGroups, openDocs]);
  const matches = wisps.filter((w) => `${w.number} ${w.title} ${w.purpose} ${w.availability}`.toLowerCase().includes(query.toLowerCase()));
  const candidateMatches = candidates.filter((entry) => `${entry.title} ${entry.range} ${entry.kind} ${entry.status} ${entry.body}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="p-catalog">
    <div className="p-catalog-controls"><label>Find a contract, profile or candidate<input type="search" placeholder="Try 100, Iroh, Ark or Trezor…" value={query} onChange={(event) => { setQuery(event.target.value); if (event.target.value) setOpenGroups(groups.map(([key]) => key)); }} /></label></div>
    <ul className="p-catalog-legend" aria-label="Catalogue color legend"><li className="p-legend-contract">Contract / process</li><li className="p-legend-implemented">Implemented · scoped evidence</li><li className="p-legend-planned">Planned / experimental</li></ul>
    <p className="p-result-count" aria-live="polite">{matches.length} of {wisps.length} WISP drafts · {candidateMatches.length} of {candidates.length} roadmap entries</p>
    {groups.map(([key, range, title, description]) => {
      const entries = matches.filter((w) => groupOf(w.number) === key);
      const roadmap = candidateMatches.filter((entry) => entry.family === key);
      if (!entries.length && !roadmap.length) return null;
      const expanded = openGroups.includes(key);
      return <section className="p-family" key={key}>
        <h2><button type="button" className="p-family-toggle" aria-expanded={expanded} aria-controls={`family-${key}`} onClick={() => setOpenGroups((items) => toggle(items, key))}><span>{range}</span>{title}<span aria-hidden="true">{expanded ? "−" : "+"}</span></button></h2>
        <p>{description}</p>
        <div id={`family-${key}`} hidden={!expanded}>
          {entries.map((w) => {
            const open = openDocs.includes(w.number);
            const previous = numbering.find((row) => row.id === w.number);
            return <section key={w.number} id={`wisp-${w.number}`} className={`p-wisp ${["Contract", "Process"].includes(w.kind) ? "p-wisp-contract" : w.state === "Implemented, scoped" ? "p-wisp-adapter p-wisp-implemented" : "p-wisp-adapter p-wisp-planned"}`}>
              {previous && previous.oldId !== w.number && !wisps.some((item) => item.number === previous.oldId) && <span id={`wisp-${previous.oldId}`} />}
              <h3><button type="button" className="p-wisp-toggle" aria-expanded={open} aria-controls={`document-${w.number}`} onClick={() => setOpenDocs((items) => toggle(items, w.number))}><span className="p-wisp-number">{w.displayNumber}</span><span className="p-wisp-title"><strong>{w.title}</strong><span className="p-wisp-kind">{w.kind}</span><small>Draft · {w.numberAssignment === "unassigned" ? "Planned · number to be defined" : w.state}</small></span><span aria-hidden="true">{open ? "−" : "+"}</span></button></h3>
              <div id={`document-${w.number}`} hidden={!open}>{open && <div className="p-wisp-content">
                <p>{w.purpose}</p><p><strong>Current scope:</strong> {w.availability}</p><p><strong>Evidence:</strong> {w.evidence} Full draft conformance is not established.</p>
                <p className="p-reader-links"><a href={referencePath(w.file)}>Share individual page ↗</a><a href={`/reference/${w.file}`} download>Download Markdown ↓</a></p>
                <article className="reference-prose"><ReferenceMarkdown body={bodies[w.number]} sourcePath={`docs/wisps/${w.file}`} idPrefix={`wisp-${w.number}-`} /></article>
              </div>}</div>
            </section>;
          })}
          {roadmap.length > 0 && <div className="p-roadmap-inventory">
            <h3>Composition & roadmap</h3>
            <p>Current integrations and future candidates from the roadmap. Planned entries have no assigned WISP number or implementation promise.</p>
            {roadmap.map((entry) => {
              const open = openDocs.includes(entry.id);
              return <section className={`p-wisp ${entry.status === "Current, scoped" ? "p-wisp-implemented" : "p-wisp-candidate"}`} key={entry.id} id={entry.id}>
                <h4><button type="button" className="p-wisp-toggle" aria-expanded={open} aria-controls={`${entry.id}-body`} onClick={() => setOpenDocs((items) => toggle(items, entry.id))}>
                  <span className="p-wisp-number">{entry.range === "Unassigned" ? "—" : entry.range}</span>
                  <span className="p-wisp-title"><strong>{entry.title}</strong><span className="p-wisp-kind">{entry.kind}</span><small>{entry.status} · roadmap entry</small></span><span aria-hidden="true">{open ? "−" : "+"}</span>
                </button></h4>
                <div id={`${entry.id}-body`} hidden={!open}>{open && <div className="p-wisp-content">
                  <article className="reference-prose"><ReferenceMarkdown body={entry.body} sourcePath="docs/wisps/ADAPTER-ROADMAP.md" idPrefix={`${entry.id}-`} /></article>
                  <p className="p-reader-links"><a href={`#${entry.id}`}>Link to this entry ↗</a><a href={`${referencePath("ADAPTER-ROADMAP.md")}#${entry.sourceAnchor}`}>Roadmap source ↗</a></p>
                </div>}</div>
              </section>;
            })}
          </div>}
        </div>
      </section>;
    })}
    {!matches.length && !candidateMatches.length && <p className="p-empty">No matching entries. <button onClick={() => setQuery("")}>Clear search</button></p>}
  </div>;
}
