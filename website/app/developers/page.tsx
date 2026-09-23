import type { Metadata } from "next";
import Link from "next/link";
import { Shell, Eyebrow } from "@/components/presentation/Shell";
import { AdapterAssembly } from "@/components/presentation/Scene";
import { LayerComposer } from "@/components/presentation/LayerComposer";
import { TechnologyCredits } from "@/components/presentation/TechnologyCredits";
export const metadata: Metadata = {
  title: "For developers",
  description:
    "A small coordination layer, negotiated capabilities and independent adapters. Explore Ghostly’s reference app, draft contracts and public roadmap.",
  alternates: { canonical: "/developers" },
};
export default function Developers() {
  return (
    <Shell active="developers" finale>
      <section className="p-hero p-wrap p-dev-hero" id="beginning">
        <Eyebrow>GHOSTLY FOR DEVELOPERS</Eyebrow>
        <h1>
          Build with <em>Ghostly.</em>
        </h1>
        <p className="p-lead">
          A small core. Negotiated capabilities. Adapters you can build on.
        </p>
        <div className="p-actions">
          <Link href="/developers/catalog" className="p-button">
            Explore the WISPs ↗
          </Link>
          <a
            href="https://github.com/MiguelMedeiros/ghostly"
            className="p-text-link"
          >
            View the source ↗
          </a>
        </div>
      </section>
      <LayerComposer />
      <section className="p-quiet">
        <div className="p-wrap p-split">
          <div>
            <Eyebrow>COMPOSITION, NOT A LOGO WALL</Eyebrow>
            <h2>
              Swap the path.
              <br />
              Keep the
              <br />
              <em>agreement.</em>
            </h2>
          </div>
          <div className="p-prose">
            <AdapterAssembly />
            <p>
              Current native paired sessions can reconnect through a supported
              alternative. Participation pins and history remain; the
              replacement connection authenticates again.
            </p>
            <small>
              Initial product pairing uses WebRTC. Browser and extension do not
              advertise the native adapters. Switching is a reconnect, not
              uninterrupted stream migration.
            </small>
            <a href="/developers/wisps/transport-increment">
              Read the implemented profile ↗
            </a>
          </div>
        </div>
      </section>
      <section className="p-section p-wrap" id="availability">
        <Eyebrow>WHAT YOU CAN VERIFY TODAY</Eyebrow>
        <h2>
          Evidence before
          <br />
          <em>green checkmarks.</em>
        </h2>
        <p className="p-lead">
          Specification, availability and validation are different questions.
        </p>
        <div className="p-table-scroll">
          <table className="p-scope-table">
            <caption>
              Local implementation scope · reviewed 22 September 2026 · public
              releases may differ
            </caption>
            <thead>
              <tr>
                <th>Capability</th>
                <th>Client / profile</th>
                <th>Evidence & boundary</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th>Chat, files & sats</th>
                <td>Current paired reference clients; mutual negotiation</td>
                <td>
                  Local receipt, persistence, integrity and payment tests.
                  Native payment frames use fixtures; not real-mint GUI
                  settlement.
                </td>
              </tr>
              <tr>
                <th>WebRTC / Iroh / HyperDHT</th>
                <td>
                  WebRTC in web/extension; native adapters locally validated on
                  macOS arm64
                </td>
                <td>
                  Real local transport tests. Two clients sharing one core do
                  not establish independent conformance.
                </td>
              </tr>
              <tr>
                <th>Voice, video & local HTTP</th>
                <td>Compatible legacy profiles and supported platforms</td>
                <td>Not enabled for every paired connection or transport.</td>
              </tr>
              <tr>
                <th>External identities & profiles</th>
                <td>Deferred; Ghostly participation only</td>
                <td>
                  Historical experiments remain in source; disabled integrations
                  are not release features.
                </td>
              </tr>
              <tr>
                <th>Groups & GossipSub</th>
                <td>Proposals</td>
                <td>Draft contracts; no implemented group adapter claimed.</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="p-actions">
          <a className="p-text-link" href="/developers/wisps/paired-capabilities">
            Files & payments evidence ↗
          </a>
          <Link className="p-text-link" href="/developers/catalog">
            All drafts ↗
          </Link>
        </div>
      </section>
      <section className="p-section p-wrap p-build">
        <Eyebrow>MAKE THE NEXT PIECE FIT</Eyebrow>
        <h2>
          Start small.
          <br />
          <em>Prove it works.</em>
        </h2>
        <div className="p-three-grid">
          <article>
            <span>01 / UNDERSTAND</span>
            <h3>Read the boundary.</h3>
            <p>
              Choose a contract. Identify the runtime, trust model, refusal
              behavior and version you implement.
            </p>
            <Link href="/developers/catalog">Find a WISP ↗</Link>
          </article>
          <article>
            <span>02 / IMPLEMENT</span>
            <h3>Use the reference.</h3>
            <p>
              Inspect the app and existing adapters. Keep discovery, signing,
              transport and application permissions separate.
            </p>
            <a href="https://github.com/MiguelMedeiros/ghostly">
              Explore the repository ↗
            </a>
          </article>
          <article>
            <span>03 / VALIDATE</span>
            <h3>Bring evidence.</h3>
            <p>
              Test failure, reconnect and recovery. Publish the exact
              client/profile matrix and independent interoperability results.
            </p>
            <a href="/developers/wisps/interop">Read the interop plan ↗</a>
          </article>
        </div>
        <div className="p-banner">
          <p>
            Have an adapter in mind?
            <br />
            <strong>Start with the outcome it makes possible.</strong>
          </p>
          <Link href="/roadmap" className="p-button secondary">
            Explore the roadmap ↗
          </Link>
        </div>
      </section>
      <TechnologyCredits />
    </Shell>
  );
}
