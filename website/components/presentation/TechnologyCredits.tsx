export function TechnologyCredits() {
  return (
    <section
      className="p-wrap technology-credits"
      aria-labelledby="technology-title"
    >
      <div>
        <p className="p-eyebrow">BUILT WITH OPEN TECHNOLOGY</p>
        <h2 id="technology-title">Good ghosts don’t build alone.</h2>
        <p>
          Technologies used in the reference implementation, within supported
          clients and profiles.
        </p>
      </div>
      <div className="technology-links">
        <a href="https://github.com/pubky/pkarr">
          <strong>Pkarr</strong>
          <span>Signed discovery records ↗</span>
        </a>
        <a href="https://www.w3.org/TR/webrtc/">
          <strong>WebRTC</strong>
          <span>Data channels & legacy media ↗</span>
        </a>
        <a href="https://docs.iroh.computer/">
          <strong>Iroh</strong>
          <span>Native connectivity ↗</span>
        </a>
        <a href="https://github.com/holepunchto/hyperdht">
          <strong>HyperDHT · Holepunch</strong>
          <span>Native discovery & streams ↗</span>
        </a>
        <a href="https://cashu.space/">
          <strong>Cashu</strong>
          <span>Ecash wallet & mint protocol ↗</span>
        </a>
      </div>
      <div className="technology-candidates">
        <p>EXPLORING NEXT · NOT INTEGRATED</p>
        <div>
          <span>
            <strong>Ark</strong> · payment adapter candidate ·{" "}
            <a href="https://docs.arkadeos.com/">Arkade ↗</a> /{" "}
            <a href="https://second.tech/">Bark ↗</a> · selection open
          </span>
          <span>
            <strong>Tether / WDK</strong> · USDT wallet candidate ·{" "}
            <a href="https://docs.wdk.tether.io/">Official docs ↗</a>
          </span>
        </div>
      </div>
      <p className="p-footnote">
        Technology credits, not partnership or sponsorship claims. For the
        people behind Ghostly, visit{" "}
        <a href="https://miguelmedeiros.dev">Miguel Medeiros ↗</a>.
      </p>
    </section>
  );
}
