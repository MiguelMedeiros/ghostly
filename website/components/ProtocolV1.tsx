"use client";

import { motion } from "motion/react";

/** Protocol v1: everything that was added on top of the chat protocol. Mirrors docs/PROTOCOL.md. */

function Block({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="mb-20 scroll-mt-24">
      <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ duration: 0.5 }}>
        <h2 className="text-2xl sm:text-3xl font-mono font-bold mb-4">{title}</h2>
        {children}
      </motion.div>
    </section>
  );
}

const P = ({ children }: { children: React.ReactNode }) => <p className="text-gray-400 leading-relaxed mb-6">{children}</p>;
const Pre = ({ children, tone = "green" }: { children: string; tone?: "green" | "cyan" }) => (
  <pre className={`bg-[#060a10] rounded-lg p-4 text-sm font-mono overflow-x-auto mb-6 border border-border/40 ${tone === "green" ? "text-green" : "text-cyan"}`}>{children}</pre>
);
const C = ({ children }: { children: React.ReactNode }) => <code className="text-gray-200 font-mono text-[0.9em]">{children}</code>;

function Rows({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border/50 bg-surface mb-6">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-gray-500 font-mono text-xs uppercase tracking-wider bg-[#060a10]">
            {head.map((h) => (
              <th key={h} className="p-3 font-normal">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row[0]} className="border-t border-border/40 align-top">
              {row.map((cell, i) => (
                <td key={i} className={`p-3 ${i === 0 ? "font-mono text-cyan whitespace-nowrap" : "text-gray-400"}`}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const List = ({ items }: { items: React.ReactNode[] }) => (
  <ul className="space-y-2 mb-6 text-gray-400">
    {items.map((item, i) => (
      <li key={i} className="flex gap-3">
        <span className="text-cyan mt-1.5 w-1.5 h-1.5 rounded-full bg-cyan shrink-0" />
        <span className="leading-relaxed">{item}</span>
      </li>
    ))}
  </ul>
);

export function ProtocolV1() {
  return (
    <>
      <Block id="services" title="Services">
        <P>
          Since 0.2 a peer advertises what it offers <em>right now</em> in the encrypted <C>_svc</C> record. Chat, voice and
          video are the services Ghostly always had; <C>http</C> is a web app on the peer&apos;s localhost. Clients that do not
          know <C>_svc</C> ignore it and keep chatting and calling, so old and new peers interoperate.
        </P>
        <Pre>{`{ "v": 1, "s": ["chat", "voice", "video",
    { "i": "my-photos", "t": "http", "n": "My photos", "p": "ghostly-http/1" }] }`}</Pre>
        <Rows
          head={["Key", "Meaning"]}
          rows={[
            ["i", "Service id, [a-z0-9][a-z0-9-]{0,31}. The only way a remote peer can name a service."],
            ["t", "Type: chat, voice, video, http, or a future one. Unknown types are kept, not rejected."],
            ["n / p / m", "Display name (48 chars), protocol spoken over the data link, optional metadata."],
          ]}
        />
        <List
          items={[
            "A bare string is shorthand for a service whose id equals its type. At most 16 services; invalid entries are dropped, the rest kept.",
            "The advertisement is authenticated twice: by the secretbox (only the linked peer could write it) and by the Pkarr signature. It never contains the local address.",
            "Presence: an advertising peer republishes every 4 minutes and counts as online while its packet carries _svc and is younger than 10 minutes. Going offline publishes once more without it.",
            "The 1000 byte packet is budgeted: signaling first, then _svc, then as many of the newest messages as still fit.",
          ]}
        />
      </Block>

      <Block id="data-link" title="The Data Link">
        <P>
          One <C>RTCPeerConnection</C> per link with a single negotiated DataChannel, <C>ghostly/1</C> (ordered, reliable).
          The DHT only carries the offer and the answer, in the <C>_rtc</C> record, using the same trick as <C>_call</C>:
          only what is unique to the session travels and each side rebuilds the SDP.
        </P>
        <Pre>{`{ "t": "o", "ts": 1789712672369, "u": "<ufrag>", "p": "<pwd>",
  "f": "<sha-256 fingerprint, hex>", "s": "actpass",
  "c": ["h,192.0.2.10,54400", "s,203.0.113.7,61000"] }`}</Pre>
        <List
          items={[
            <>An answer has <C>&quot;t&quot;: &quot;a&quot;</C> and <C>&quot;o&quot;</C>, the timestamp of the offer it answers. Candidates are <C>h|s|r,address,port</C>: host, server reflexive, relay.</>,
            "The DTLS fingerprint arrives inside a record that is encrypted with the link key and signed by the peer's key: a DTLS session with that fingerprint is a session with that peer.",
            "Either side may offer; the other answers on its own, because the link already authenticated the peer. If both offer at once, the lower public key keeps its offer. Clients may open the link unprompted when the peer is online.",
            "Every field is validated against strict patterns before it goes near an SDP. Signals older than 120 s are ignored.",
            "Once open, chat messages, call signaling, files, payments and HTTP all go over the channel, and each side first flushes the messages the other had not acknowledged through the DHT.",
          ]}
        />
        <h3 className="text-lg font-mono font-bold mb-4">Framing</h3>
        <P>
          Text messages are control frames: compact JSON with a <C>t</C> discriminator. Binary messages are body chunks that
          belong to a stream opened by a control frame. Messages are at most 16 KiB; senders pause above 1 MiB of buffered data.
        </P>
        <Pre tone="cyan">{`<kind u8> <stream id u32 BE> <flags u8> <payload>
kind   1 = request body, 2 = response body, 3 = file
flags  bit 0 = END`}</Pre>
        <Rows
          head={["Frame", "Meaning"]}
          rows={[
            ["hello", "First frame each way: protocol version and the authoritative service list."],
            ["svc", "The service list changed."],
            ["m", "A chat message: { ts, m }. Used instead of _msgs while the channel is open."],
            ["call", "A _call signal, sent here too so a connected peer rings at once."],
            ["req / res / rst", "HTTP over the link, below."],
            ["file", "A file announcement, below."],
            ["pay-req / pay / pay-res", "Payments, below."],
          ]}
        />
      </Block>

      <Block id="http" title="HTTP over WebRTC">
        <P>
          <C>ghostly-http/1</C>. The client names a service id and an origin-form path. There is no field for a host, a port
          or a URL: the host owns the mapping from id to the loopback address its user configured.
        </P>
        <Pre>{`→ { "t": "req", "id": 7, "s": "my-photos", "m": "POST", "p": "/api/items?x=1",
    "h": [["content-type","application/json"]], "b": true }
→ chunk(kind 1, id 7) … chunk(kind 1, id 7, END)
← { "t": "res", "id": 7, "st": 201, "h": [["content-type","application/json"]], "b": true }
← chunk(kind 2, id 7) … chunk(kind 2, id 7, END)`}</Pre>
        <h3 className="text-lg font-mono font-bold mb-4">What the host guarantees</h3>
        <List
          items={[
            "A service id resolves only through the user's list, and only while the service is enabled.",
            "Targets are loopback only (localhost, 127.0.0.1, [::1]), http or https, without credentials.",
            "The path must start with a single slash and, after URL normalization, still sit on the target's origin and under its base path. Anything else is refused without touching the network.",
            "Hop-by-hop headers, Host, Origin, Referer, forwarding headers and Sec-*/Proxy-* are removed. Requests never carry the host user's cookies or HTTP credentials.",
            "Redirects never leave the target. Location headers are made relative, so the local address is neither disclosed nor followed.",
            "Limits: 8 MiB request bodies, 32 concurrent requests per peer, 60 s for the local app to answer, 30 s of body silence. Clients cap responses at 64 MiB.",
          ]}
        />
        <P>
          Host errors are ordinary responses with an <C>x-ghostly-error</C> header (404 unknown-service, 400 bad-path, 413,
          502 unreachable, 503 busy, 504 timeout), so a browser can render them.
        </P>
      </Block>

      <Block id="files" title="Files">
        <Pre>{`→ { "t": "file", "id": 3, "f": "Zk3v…", "ts": 1789712672369,
    "n": "floor plan.pdf", "s": 482113, "m": "application/pdf" }
→ chunk(kind 3, id 3) … chunk(kind 3, id 3, END)`}</Pre>
        <List
          items={[
            "Files only travel over the data link, never through the DHT: both peers have to be online.",
            "The receiver keeps the file only if exactly s bytes arrived before END. More, fewer, or 30 s of silence discard it.",
            "100 MiB per file, 3 incoming files per peer at a time. Either side cancels with rst.",
            "The name is display text and a download suggestion, never a path. Receivers store files under their own ids and never open them on their own.",
          ]}
        />
      </Block>

      <Block id="payments" title="Payments">
        <P>
          Ghostly does not move money. It carries payment requests, payments that fit in a message (ecash) and receipts
          between two linked peers; a wallet on each side does the rest. The vocabulary is{" "}
          <a href="https://github.com/pubky/paykit-rs" target="_blank" rel="noopener noreferrer" className="text-cyan hover:underline">Paykit</a>
          &apos;s: an endpoint is an identifier plus a payload, an amount is decimal text plus an asset.
        </P>
        <Pre>{`← { "t": "pay-req", "id": "Qm3…", "v": "1000", "u": "sat", "memo": "coffee",
    "e": [["btc-lightning-bolt11", "lnbc10u1…"], ["cashu", "{\\"mints\\":[\\"https://mint.example\\"]}"]] }
→ { "t": "pay", "id": "p8Kx…", "rid": "Qm3…", "v": "1000", "u": "sat", "e": ["cashu", "cashuB…"] }
← { "t": "pay-res", "id": "p8Kx…", "ok": true, "v": "1000" }`}</Pre>
        <List
          items={[
            "A request lists every way to be paid: a Lightning invoice anyone can pay from any wallet, and the mints the payee accepts ecash from.",
            "An ecash token is a bearer instrument. Payees redeem on receipt, before answering. Payers keep the token until pay-res arrives and take it back if the payment is refused or never confirmed.",
            "A payee only accepts ecash from mints it chose. Anything else is refused, and the payer falls back to the Lightning endpoint, which works across mints.",
            "Amounts are decimal text, never floats. A repeated pay id is answered with the earlier result and redeemed once.",
          ]}
        />
      </Block>

      <Block id="clients" title="Clients & Relays">
        <P>
          One peer implementation in TypeScript (<C>@ghostly/core</C> and <C>@ghostly/browser</C>) runs in three hosts, and the
          Rust CLI speaks the chat subset. An invite from any of them works in the others.
        </P>
        <Rows
          head={["Client", "Reaches Pkarr", "Shares localhost", "Opens a contact's app"]}
          rows={[
            ["Desktop", "Mainline DHT directly (Rust), plus relays", "Yes, through Rust, with cookies", "A window per service on its own origin"],
            ["Extension", "HTTP relays", "Yes, with Chrome's host permission", "A tab on a virtual origin"],
            ["Web", "HTTP relays", "No: a page may not reach your machine", "Not yet"],
            ["CLI", "Mainline DHT directly", "—", "—"],
          ]}
        />
        <List
          items={[
            <>A relay is an HTTP bridge to the DHT: <C>PUT</C> and <C>GET /&lt;key&gt;</C> with <C>signature(64) · timestamp(8) · DNS packet</C>. It sees signed, encrypted packets and never carries application traffic.</>,
            "Public relays allow about 120 requests a minute per IP. Relay clients spend one request per poll (relays in turn, newest signed packet wins), back off on 429 and on network errors, and keep to 30 requests a minute per relay.",
            <>Publishes carry <C>If-Match: &lt;timestamp of the packet being replaced&gt;</C>; without it a relay refuses with 428 while the previous put is still in flight.</>,
            "Relay poll timings: 4 s while a chat is open, 2 s while signaling (for at most 45 s), 30 s in the background, 60 s while the data link is up. DHT clients keep the timings below.",
          ]}
        />
        <P>
          The full specification lives in the repository:{" "}
          <a href="https://github.com/MiguelMedeiros/ghostly/blob/main/docs/PROTOCOL.md" target="_blank" rel="noopener noreferrer" className="text-cyan hover:underline">docs/PROTOCOL.md</a>.
        </P>
      </Block>
    </>
  );
}
