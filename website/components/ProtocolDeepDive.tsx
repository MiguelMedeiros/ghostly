import { GhostGlyph, Icon } from "./icons";

export function ProtocolDeepDive() {
  return (
    <section
      id="protocol"
      className="landing-section"
      aria-labelledby="protocol-heading"
    >
      <div className="landing-wrap protocol-layout">
        <div className="section-heading">
          <p className="eyebrow">A little network magic. Real engineering.</p>
          <h2 id="protocol-heading">
            The secret behind
            <br />
            the haunting.
          </h2>
          <p>
            Ghostly is an app built on an open protocol. It lets two devices
            find each other, connect, and share what they can do.
          </p>
          <a className="text-link" href="/docs">
            Explore the protocol <span aria-hidden="true">↗</span>
          </a>
        </div>
        <div className="protocol-card">
          <div
            className="network-diagram"
            role="img"
            aria-label="Your device and your contact use Pkarr and the DHT to find each other, then connect with encrypted WebRTC."
          >
            <div className="discovery-node">
              <Icon name="globe" />
              <span>
                Pkarr + DHT<small>Find each other</small>
              </span>
            </div>
            <div className="discovery-lines" aria-hidden="true" />
            <div className="peer-row">
              <div className="peer-node">
                <GhostGlyph />
                <span>You</span>
              </div>
              <div className="peer-connection">
                <span className="protocol-packet" aria-hidden="true" />
                <span className="protocol-packet second" aria-hidden="true" />
                <Icon name="key" />
                <span>Encrypted WebRTC</span>
              </div>
              <div className="peer-node other">
                <GhostGlyph />
                <span>Your contact</span>
              </div>
            </div>
          </div>
          <div className="protocol-explanations">
            <div>
              <span>01</span>
              <p>
                <strong>A fresh identity for each connection.</strong> Your
                invite creates a pair of identities and a shared secret. No
                public profile to register.
              </p>
            </div>
            <div>
              <span>02</span>
              <p>
                <strong>A distributed way to meet.</strong> Small, signed Pkarr
                records on the DHT carry encrypted discovery information and
                fallback text messages.
              </p>
            </div>
            <div>
              <span>03</span>
              <p>
                <strong>A connection for everything else.</strong> WebRTC
                carries live chat, calls, files, ecash and requests to shared
                apps between your devices.
              </p>
            </div>
          </div>
          <p className="protocol-footnote">
            Browsers use Pkarr relays. STUN helps establish connections;
            optional TURN can relay encrypted traffic when a direct route is
            unavailable.
          </p>
        </div>
      </div>
      <div className="landing-wrap lifecycle-note">
        <GhostGlyph />
        <div>
          <h3>Available while you’re online. That’s the ephemeral part.</h3>
          <p>
            Go offline and your live services become unreachable. Network
            records expire over time. Chats and received files remain on your
            device until you delete them.
          </p>
        </div>
        <a href="#faq" className="text-link">
          The details <span aria-hidden="true">↓</span>
        </a>
      </div>
    </section>
  );
}
