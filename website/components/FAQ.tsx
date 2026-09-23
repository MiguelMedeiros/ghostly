const faqs = [
  {
    question: "What actually disappears when I go offline?",
    answer:
      "Your live connection ends, and contacts can no longer reach apps you were sharing. Published network records expire over time; closing Ghostly does not instantly erase them. Your keys, chat history, received files and wallet are stored locally and survive restarts. Deleting a chat removes your local copy, not your contact’s copy or files they saved elsewhere.",
  },
  {
    question: "Do both of us need to be online?",
    answer:
      "For calls, files, chat payments and shared apps, yes. Short text messages can also travel through encrypted Pkarr records on the DHT, but those records are temporary and limited in size. Ghostly is best for connecting while you’re both around; it is not a guaranteed offline inbox. The web app must stay open, and incoming calls in the extension need a Ghostly tab open.",
  },
  {
    question: "Who can open an app I share?",
    answer:
      "All contacts you are linked with can access every app you enable for sharing. There is no per-contact service selection yet. You choose a loopback address on your computer; contacts request a service ID, not arbitrary addresses. They can use that app’s functionality, so share an app only with people you intend to give access to it. Both ends need the desktop app or extension. WebSockets, hot reload and streaming responses are not supported; cookie-based apps also have limitations with an extension host.",
  },
  {
    question: "Does peer to peer mean there are no servers at all?",
    answer:
      "There is no central Ghostly message server or account database. The network still uses infrastructure: browsers reach the DHT through Pkarr relays, STUN helps devices connect, and optional TURN can relay encrypted traffic. Wallet mints handle ecash and Lightning. Encryption protects conversation content, but it does not hide all network metadata or your IP address. Keep invite links private: they contain the keys for joining a connection.",
  },
  {
    question: "How does the sats wallet work?",
    answer:
      "The wallet holds Cashu ecash issued by mints you choose. You can send and request sats in chat, receive Lightning payments and pay Lightning invoices. Mints hold the underlying funds, so this is custodial and a mint can lose funds or stop operating. There is no recovery seed yet. Use Copy backup tokens in wallet settings; anyone with those tokens can spend them. Test mints are available with worthless sats to try the flow.",
  },
  {
    question: "Can I use it on my phone?",
    answer:
      "Yes. Open app.ghostly.tools in your phone’s browser and optionally add it to the home screen. Chat, voice, video, files and sats are available. Screen sharing needs a supported computer, and sharing or opening local apps needs desktop or the browser extension. The web app is served fresh from its host, so use a host you trust or self-host it.",
  },
  {
    question: "Is Ghostly free? Can I inspect or host it myself?",
    answer:
      "Ghostly is free and open source under the MIT license. The app, CLI and protocol code are on GitHub, and you can self-host the web app. There is no Ghostly subscription. Ecash mints and Lightning payments may charge fees, which the wallet shows. The project is still evolving; check the documentation for current platform and feature limitations.",
  },
];

export function FAQ() {
  return (
    <section id="faq" className="landing-section" aria-labelledby="faq-heading">
      <div className="landing-wrap faq-layout">
        <div className="section-heading">
          <p className="eyebrow">Good questions. Straight answers.</p>
          <h2 id="faq-heading">
            A few things
            <br />
            worth knowing.
          </h2>
          <p>The useful details, before you make yourself at home.</p>
          <a href="/docs" className="text-link">
            Read the documentation <span aria-hidden="true">↗</span>
          </a>
        </div>
        <div className="faq-items">
          {faqs.map((faq) => (
            <details key={faq.question} className="faq-item">
              <summary>
                {faq.question}
                <span aria-hidden="true">+</span>
              </summary>
              <p>{faq.answer}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
