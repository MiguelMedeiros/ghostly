"use client";

import { motion } from "motion/react";
import { useState, useEffect } from "react";

const SectionIcons = {
  overview: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" />
    </svg>
  ),
  architecture: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6.429 9.75L2.25 12l4.179 2.25m0-4.5l5.571 3 5.571-3m-11.142 0L2.25 7.5 12 2.25l9.75 5.25-4.179 2.25m0 0L21.75 12l-4.179 2.25m0 0l4.179 2.25L12 21.75l-9.75-5.25 4.179-2.25m11.142 0l-5.571 3-5.571-3" />
    </svg>
  ),
  "dns-records": (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
    </svg>
  ),
  "message-types": (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
    </svg>
  ),
  "call-signaling": (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 002.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 01-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 00-1.091-.852H4.5A2.25 2.25 0 002.25 4.5v2.25z" />
    </svg>
  ),
  encryption: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
    </svg>
  ),
  timing: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  ),
  "technical-faq": (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9 5.25h.008v.008H12v-.008z" />
    </svg>
  ),
};

const sections = [
  { id: "overview", label: "Overview" },
  { id: "architecture", label: "Architecture" },
  { id: "dns-records", label: "DNS Records" },
  { id: "message-types", label: "Message Types" },
  { id: "call-signaling", label: "Call Signaling" },
  { id: "encryption", label: "Encryption" },
  { id: "timing", label: "Timing & Limits" },
  { id: "technical-faq", label: "Technical FAQ" },
];

const dnsRecords = [
  {
    name: "_msgs",
    type: "TXT",
    description: "Encrypted message payload containing an array of messages",
    encrypted: true,
    required: true,
    maxSize: "~800 chars (base64)",
    schema: `[
  {
    "t": 1708894521000,
    "m": "Hello world"
  }
]`,
    example: `_msgs TXT "nonce_b64+ciphertext_b64"`,
    notes: "Messages are sorted by timestamp. Older messages are dropped when payload exceeds limit.",
  },
  {
    name: "_ts",
    type: "TXT",
    description: "Timestamp of the latest message in the batch",
    encrypted: false,
    required: true,
    maxSize: "13-14 chars",
    schema: `"1708894521000"`,
    example: `_ts TXT "1708894521000"`,
    notes: "Used by receiver to determine if new messages are available without decryption.",
  },
  {
    name: "_ack",
    type: "TXT",
    description: "Acknowledgment timestamp — confirms receipt of peer messages",
    encrypted: false,
    required: false,
    maxSize: "13-14 chars",
    schema: `"1708894518000"`,
    example: `_ack TXT "1708894518000"`,
    notes: "When peer sees their message timestamp in your _ack, they know you received it.",
  },
  {
    name: "_nick",
    type: "TXT",
    description: "Encrypted display name / nickname",
    encrypted: true,
    required: false,
    maxSize: "~100 chars",
    schema: `"Alice"`,
    example: `_nick TXT "encrypted_nickname_b64"`,
    notes: "Optional. Allows users to set a human-readable name.",
  },
  {
    name: "_call",
    type: "TXT",
    description: "WebRTC call signaling data",
    encrypted: true,
    required: false,
    maxSize: "~500 chars",
    schema: `{
  "t": "o",
  "ts": 1708894521000,
  "u": "ufrag",
  "p": "pwd",
  "f": "fingerprint",
  "s": "sdp",
  "m": ["mid1"],
  "c": ["candidate"],
  "ss": [0, 1]
}`,
    example: `_call TXT "encrypted_signal_b64"`,
    notes: "Enables peer-to-peer voice/video calls. Signal is cleared after call ends.",
  },
];

const messageTypes = [
  {
    type: "Text Message",
    sender: "me | peer",
    description: "Standard chat message between participants",
    fields: [
      { name: "id", type: "string", desc: 'Unique ID (e.g., "me_1708894521000")' },
      { name: "text", type: "string", desc: "Message content (max 500 bytes)" },
      { name: "sender", type: '"me" | "peer"', desc: "Message direction" },
      { name: "timestamp", type: "number", desc: "Unix timestamp (ms)" },
      { name: "nick?", type: "string", desc: "Optional nickname" },
      { name: "meta?", type: "MessageMeta", desc: "DHT metadata" },
    ],
  },
  {
    type: "System: Join",
    sender: "system",
    description: "Emitted when a peer joins the chat session",
    fields: [
      { name: "text", type: "string", desc: '"👋 joined"' },
      { name: "sender", type: '"system"', desc: "System message" },
      { name: "systemEvent.type", type: '"join"', desc: "Event type" },
      { name: "systemEvent.pubKey", type: "string", desc: "Peer public key (z32)" },
    ],
  },
  {
    type: "Call: Started",
    sender: "system",
    description: "Outgoing call initiated",
    fields: [
      { name: "callEvent.type", type: '"call_started"', desc: "Event type" },
      { name: "callEvent.hasVideo", type: "boolean", desc: "Video enabled" },
    ],
  },
  {
    type: "Call: Received",
    sender: "system",
    description: "Incoming call notification",
    fields: [
      { name: "callEvent.type", type: '"call_received"', desc: "Event type" },
      { name: "callEvent.hasVideo", type: "boolean", desc: "Video enabled" },
    ],
  },
  {
    type: "Call: Connected",
    sender: "system",
    description: "Call successfully established",
    fields: [
      { name: "callEvent.type", type: '"call_connected"', desc: "Event type" },
      { name: "callEvent.hasVideo", type: "boolean", desc: "Video enabled" },
    ],
  },
  {
    type: "Call: Ended",
    sender: "system",
    description: "Call terminated normally",
    fields: [
      { name: "callEvent.type", type: '"call_ended"', desc: "Event type" },
      { name: "callEvent.hasVideo", type: "boolean", desc: "Video enabled" },
      { name: "callEvent.duration", type: "number", desc: "Call duration (seconds)" },
    ],
  },
  {
    type: "Call: Missed",
    sender: "system",
    description: "Incoming call was not answered",
    fields: [
      { name: "callEvent.type", type: '"call_missed"', desc: "Event type" },
      { name: "callEvent.hasVideo", type: "boolean", desc: "Video enabled" },
    ],
  },
  {
    type: "Call: Rejected",
    sender: "system",
    description: "Call was declined by recipient",
    fields: [
      { name: "callEvent.type", type: '"call_rejected"', desc: "Event type" },
      { name: "callEvent.hasVideo", type: "boolean", desc: "Video enabled" },
    ],
  },
];

const callSignalTypes = [
  {
    type: "o",
    name: "Offer",
    description: "Initial call offer with SDP and ICE credentials",
    direction: "Caller → Callee",
  },
  {
    type: "a",
    name: "Answer",
    description: "Response to offer with callee's SDP and ICE info",
    direction: "Callee → Caller",
  },
  {
    type: "h",
    name: "Hangup",
    description: "Terminate or reject the call",
    direction: "Either → Either",
  },
];

export function ProtocolDocs() {
  const [activeSection, setActiveSection] = useState("overview");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      const sectionElements = sections.map((s) => ({
        id: s.id,
        el: document.getElementById(s.id),
      }));

      for (const section of sectionElements.reverse()) {
        if (section.el) {
          const rect = section.el.getBoundingClientRect();
          if (rect.top <= 120) {
            setActiveSection(section.id);
            break;
          }
        }
      }
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <div className="min-h-screen flex justify-center">
      <div className="docs-container flex relative">
        {/* Mobile menu button */}
        <button
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          className="lg:hidden fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full bg-cyan text-black flex items-center justify-center shadow-lg shadow-cyan/20"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>

        {/* Sidebar */}
        <aside
          className={`w-64 flex-shrink-0 h-[calc(100vh-4rem)] bg-[#060a10]/95 backdrop-blur-xl border-r border-border/50 overflow-y-auto z-40 transition-transform duration-300 sticky top-16 hidden lg:block ${
            mobileMenuOpen ? "mobile-menu-open !fixed !left-0 !block top-16" : ""
          }`}
      >
        <div className="px-4 pt-3 pb-3">
          <nav className="space-y-0.5">
            {sections.map((section) => (
              <a
                key={section.id}
                href={`#${section.id}`}
                onClick={() => setMobileMenuOpen(false)}
                className={`flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-all ${
                  activeSection === section.id
                    ? "bg-cyan/10 text-cyan border-l-2 border-cyan"
                    : "text-gray-400 hover:text-gray-200 hover:bg-surface"
                }`}
              >
                <span className="text-cyan/70">{SectionIcons[section.id as keyof typeof SectionIcons]}</span>
                {section.label}
              </a>
            ))}
          </nav>

          <div className="mt-12 pt-6 border-t border-border/50">
            <a
              href="https://github.com/MiguelMedeiros/ghostly"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 px-4 py-3 rounded-lg text-sm text-gray-500 hover:text-gray-300 transition-colors"
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
              </svg>
              View Source
            </a>
            <a
              href="https://pkarr.org"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 px-4 py-3 rounded-lg text-sm text-gray-500 hover:text-gray-300 transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
              </svg>
              Learn Pkarr
            </a>
          </div>
        </div>
      </aside>

      {/* Mobile overlay */}
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-30 lg:hidden"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}

        {/* Main content */}
        <main className="flex-1 min-w-0">
        <div className="py-12 lg:py-16 lg:pl-8">
          
          {/* Overview Section */}
          <section id="overview" className="mb-20">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5 }}
            >
              <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-cyan/10 border border-cyan/20 text-cyan text-xs font-mono mb-6">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
                </svg>
                Developer Documentation
              </span>
              
              <h1 className="text-4xl sm:text-5xl font-mono font-bold mb-6">
                Protocol{" "}
                <span className="text-gradient">Specification</span>
              </h1>
              
              <p className="text-lg text-gray-400 leading-relaxed mb-8">
                Complete reference for the Ghostly messaging protocol. This document covers DNS TXT records
                over Mainline DHT, end-to-end encryption schemes, message formats, and WebRTC call signaling.
              </p>

              <div className="flex flex-wrap gap-3">
                {["Pkarr", "BEP44", "Ed25519", "NaCl", "WebRTC"].map((tech) => (
                  <span
                    key={tech}
                    className="px-3 py-1.5 rounded-lg bg-surface border border-border/50 text-sm font-mono text-gray-400"
                  >
                    {tech}
                  </span>
                ))}
              </div>
            </motion.div>
          </section>

          {/* Architecture Section */}
          <section id="architecture" className="mb-20">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5 }}
            >
              <h2 className="text-2xl sm:text-3xl font-mono font-bold mb-6">
                Architecture
              </h2>
              
              <p className="text-gray-400 leading-relaxed mb-8">
                Ghostly uses <strong className="text-gray-200">Pkarr</strong> (Public Key Addressable Resource Records)
                to publish encrypted messages to the <strong className="text-gray-200">Mainline DHT</strong> — the same
                distributed hash table that powers BitTorrent with 10M+ nodes.
              </p>

              <div className="rounded-xl border border-border/50 bg-surface overflow-hidden mb-8">
                <div className="px-6 py-4 border-b border-border/50 bg-[#060a10]">
                  <span className="text-sm font-mono text-gray-500">// Protocol Stack</span>
                </div>
                <div className="p-6">
                  <div className="space-y-3">
                    {[
                      { label: "Application", value: "Ghostly Chat", color: "cyan" },
                      { label: "Encryption", value: "NaCl secretbox", color: "green" },
                      { label: "Signing", value: "Ed25519", color: "yellow" },
                      { label: "Records", value: "Pkarr / DNS TXT", color: "purple" },
                      { label: "Transport", value: "BEP44 Mutable Items", color: "pink" },
                      { label: "Network", value: "Mainline DHT (UDP)", color: "gray" },
                    ].map((item) => (
                      <div key={item.label} className="flex items-center gap-4">
                        <span className="w-28 text-right text-sm text-gray-500 font-mono">{item.label}</span>
                        <div className="flex-1 h-px bg-border/30" />
                        <span className={`px-3 py-1.5 rounded-lg text-sm font-mono bg-${item.color === "gray" ? "surface-light" : `${item.color}/10`} text-${item.color === "gray" ? "gray-400" : item.color === "yellow" ? "yellow-400" : item.color === "pink" ? "pink-400" : item.color === "purple" ? "purple-400" : item.color}`}>
                          {item.value}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-border/50 bg-surface p-6">
                <h3 className="text-lg font-mono font-bold mb-4">Two-Channel Architecture</h3>
                <p className="text-gray-400 text-sm leading-relaxed mb-4">
                  Each chat session uses <strong className="text-cyan">two Ed25519 keypairs</strong> (one per participant)
                  and <strong className="text-green">one shared symmetric key</strong> for encryption. Each party writes
                  to their own keypair and reads from the peer&apos;s.
                </p>
                <pre className="bg-[#060a10] rounded-lg p-4 text-sm font-mono overflow-x-auto">
                  <code className="text-gray-300">{`Alice: writes → keypairA, reads ← keypairB
Bob:   writes → keypairB, reads ← keypairA
Both:  encrypt/decrypt with shared encKey (256-bit)`}</code>
                </pre>
              </div>
            </motion.div>
          </section>

          {/* DNS Records Section */}
          <section id="dns-records" className="mb-20">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5 }}
            >
              <h2 className="text-2xl sm:text-3xl font-mono font-bold mb-4">
                DNS TXT Records
              </h2>
              
              <p className="text-gray-400 leading-relaxed mb-8">
                Each Pkarr packet contains multiple DNS TXT records. These are published to the DHT
                and can be resolved by anyone with the public key.
              </p>

              <div className="space-y-6">
                {dnsRecords.map((record, i) => (
                  <motion.div
                    key={record.name}
                    initial={{ opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.4, delay: i * 0.05 }}
                    className="rounded-xl border border-border/50 bg-surface overflow-hidden"
                  >
                    <div className="px-6 py-4 border-b border-border/50 flex flex-wrap items-center gap-3 bg-[#060a10]">
                      <code className="text-lg font-mono font-bold text-cyan">{record.name}</code>
                      <span className="px-2 py-0.5 text-xs font-mono bg-surface-light rounded text-gray-400">
                        {record.type}
                      </span>
                      {record.encrypted && (
                        <span className="px-2 py-0.5 text-xs font-medium bg-green/10 text-green rounded-full">
                          Encrypted
                        </span>
                      )}
                      {record.required ? (
                        <span className="px-2 py-0.5 text-xs font-medium bg-yellow-500/10 text-yellow-400 rounded-full">
                          Required
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 text-xs font-medium bg-gray-500/10 text-gray-500 rounded-full">
                          Optional
                        </span>
                      )}
                    </div>
                    
                    <div className="p-6">
                      <p className="text-gray-300 mb-6">{record.description}</p>
                      
                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
                        <div>
                          <div className="text-xs font-mono text-gray-500 mb-2 uppercase tracking-wider">
                            Schema (decrypted)
                          </div>
                          <pre className="bg-[#060a10] rounded-lg p-4 text-sm font-mono text-green overflow-x-auto">
                            {record.schema}
                          </pre>
                        </div>
                        <div>
                          <div className="text-xs font-mono text-gray-500 mb-2 uppercase tracking-wider">
                            Wire Format
                          </div>
                          <pre className="bg-[#060a10] rounded-lg p-4 text-sm font-mono text-cyan overflow-x-auto">
                            {record.example}
                          </pre>
                        </div>
                      </div>

                      <div className="flex items-center gap-6 text-sm text-gray-500 mb-4">
                        <span>Max size: <code className="text-gray-300">{record.maxSize}</code></span>
                      </div>

                      <p className="text-sm text-gray-500 italic border-l-2 border-border/50 pl-4">
                        {record.notes}
                      </p>
                    </div>
                  </motion.div>
                ))}
              </div>
            </motion.div>
          </section>

          {/* Message Types Section */}
          <section id="message-types" className="mb-20">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5 }}
            >
              <h2 className="text-2xl sm:text-3xl font-mono font-bold mb-4">
                Message Types
              </h2>
              
              <p className="text-gray-400 leading-relaxed mb-8">
                The application layer defines several message types for chat, system events, and call signaling.
                All messages follow the <code className="text-cyan">ChatMessage</code> interface.
              </p>

              <div className="space-y-6">
                {messageTypes.map((msg, i) => (
                  <motion.div
                    key={msg.type}
                    initial={{ opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.4, delay: i * 0.03 }}
                    className="rounded-xl border border-border/50 bg-surface overflow-hidden"
                  >
                    <div className="px-6 py-4 border-b border-border/50 flex items-center justify-between bg-[#060a10]">
                      <span className="font-mono font-bold text-gray-100">{msg.type}</span>
                      <code className="text-xs px-2 py-1 bg-surface-light rounded text-gray-500">
                        sender: &quot;{msg.sender}&quot;
                      </code>
                    </div>
                    
                    <div className="p-6">
                      <p className="text-gray-400 mb-4">{msg.description}</p>
                      
                      <div className="rounded-lg bg-[#060a10] overflow-hidden">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-border/30">
                              <th className="text-left py-2 px-4 font-mono text-gray-500 font-normal">Field</th>
                              <th className="text-left py-2 px-4 font-mono text-gray-500 font-normal">Type</th>
                              <th className="text-left py-2 px-4 font-mono text-gray-500 font-normal">Description</th>
                            </tr>
                          </thead>
                          <tbody>
                            {msg.fields.map((field) => (
                              <tr key={field.name} className="border-b border-border/20 last:border-0">
                                <td className="py-2 px-4 font-mono text-cyan">{field.name}</td>
                                <td className="py-2 px-4 font-mono text-green text-xs">{field.type}</td>
                                <td className="py-2 px-4 text-gray-400">{field.desc}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </motion.div>
                ))}
              </div>
            </motion.div>
          </section>

          {/* Call Signaling Section */}
          <section id="call-signaling" className="mb-20">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5 }}
            >
              <h2 className="text-2xl sm:text-3xl font-mono font-bold mb-4">
                Call Signaling
              </h2>
              
              <p className="text-gray-400 leading-relaxed mb-8">
                WebRTC signaling is performed through the <code className="text-cyan">_call</code> DNS record.
                The signal payload is compressed and encrypted before publishing.
              </p>

              <div className="rounded-xl border border-border/50 bg-surface overflow-hidden mb-8">
                <div className="px-6 py-4 border-b border-border/50 bg-[#060a10]">
                  <span className="font-mono font-bold text-gray-100">Signal Types</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border/50">
                        <th className="text-left py-3 px-6 font-mono text-gray-500 font-normal">Type</th>
                        <th className="text-left py-3 px-6 font-mono text-gray-500 font-normal">Name</th>
                        <th className="text-left py-3 px-6 font-mono text-gray-500 font-normal">Direction</th>
                        <th className="text-left py-3 px-6 font-mono text-gray-500 font-normal">Description</th>
                      </tr>
                    </thead>
                    <tbody>
                      {callSignalTypes.map((sig) => (
                        <tr key={sig.type} className="border-b border-border/30 last:border-0">
                          <td className="py-3 px-6">
                            <code className="px-2 py-1 bg-cyan/10 text-cyan rounded font-mono">
                              &quot;{sig.type}&quot;
                            </code>
                          </td>
                          <td className="py-3 px-6 font-medium text-gray-200">{sig.name}</td>
                          <td className="py-3 px-6 text-gray-400 font-mono text-xs">{sig.direction}</td>
                          <td className="py-3 px-6 text-gray-400">{sig.description}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="rounded-xl border border-border/50 bg-surface overflow-hidden">
                <div className="px-6 py-4 border-b border-border/50 bg-[#060a10]">
                  <span className="font-mono font-bold text-gray-100">CallSignal Interface</span>
                </div>
                <div className="p-6">
                  <pre className="bg-[#060a10] rounded-lg p-6 font-mono text-sm overflow-x-auto">
                    <code className="text-gray-300">{`interface CallSignal {
  t: "o" | "a" | "h";   // offer / answer / hangup
  ts: number;           // timestamp for glare resolution

  // ICE credentials (offer/answer only)
  u?: string;           // ufrag
  p?: string;           // password

  // DTLS fingerprint (offer/answer only)
  f?: string;           // SHA-256 fingerprint

  // SDP data (offer/answer only)
  s?: string;           // compressed SDP
  m?: string[];         // media section IDs

  // ICE candidates
  c?: string[];         // candidate strings

  // SSRC values
  ss?: number[];        // synchronization source IDs
}`}</code>
                  </pre>
                </div>
              </div>
            </motion.div>
          </section>

          {/* Encryption Section */}
          <section id="encryption" className="mb-20">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5 }}
            >
              <h2 className="text-2xl sm:text-3xl font-mono font-bold mb-4">
                Encryption
              </h2>
              
              <p className="text-gray-400 leading-relaxed mb-8">
                All sensitive data is encrypted using NaCl secretbox before being published to the DHT.
                Packets are signed with Ed25519 to prove authenticity.
              </p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
                <div className="rounded-xl border border-border/50 bg-surface overflow-hidden">
                  <div className="px-6 py-4 border-b border-border/50 bg-[#060a10]">
                    <span className="font-mono font-bold text-gray-100">Symmetric Encryption</span>
                  </div>
                  <div className="p-6 space-y-4">
                    <div className="flex justify-between items-center py-2 border-b border-border/30">
                      <span className="text-gray-500">Algorithm</span>
                      <code className="text-cyan">XSalsa20-Poly1305</code>
                    </div>
                    <div className="flex justify-between items-center py-2 border-b border-border/30">
                      <span className="text-gray-500">Key size</span>
                      <code className="text-cyan">256 bits</code>
                    </div>
                    <div className="flex justify-between items-center py-2 border-b border-border/30">
                      <span className="text-gray-500">Nonce size</span>
                      <code className="text-cyan">192 bits</code>
                    </div>
                    <div className="flex justify-between items-center py-2">
                      <span className="text-gray-500">Output</span>
                      <code className="text-cyan text-xs">nonce || ciphertext</code>
                    </div>
                  </div>
                </div>

                <div className="rounded-xl border border-border/50 bg-surface overflow-hidden">
                  <div className="px-6 py-4 border-b border-border/50 bg-[#060a10]">
                    <span className="font-mono font-bold text-gray-100">Signing (Pkarr)</span>
                  </div>
                  <div className="p-6 space-y-4">
                    <div className="flex justify-between items-center py-2 border-b border-border/30">
                      <span className="text-gray-500">Algorithm</span>
                      <code className="text-green">Ed25519</code>
                    </div>
                    <div className="flex justify-between items-center py-2 border-b border-border/30">
                      <span className="text-gray-500">Key encoding</span>
                      <code className="text-green">z-base-32</code>
                    </div>
                    <div className="flex justify-between items-center py-2 border-b border-border/30">
                      <span className="text-gray-500">Seed size</span>
                      <code className="text-green">32 bytes</code>
                    </div>
                    <div className="flex justify-between items-center py-2">
                      <span className="text-gray-500">Storage</span>
                      <code className="text-green">BEP44</code>
                    </div>
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-border/50 bg-surface p-6">
                <h3 className="font-mono font-bold mb-4">Encryption Pipeline</h3>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  {[
                    { label: "Plaintext", bg: "bg-surface-light", color: "text-gray-300" },
                    { arrow: true },
                    { label: "JSON", bg: "bg-surface-light", color: "text-gray-300" },
                    { arrow: true },
                    { label: "secretbox()", bg: "bg-cyan/10", color: "text-cyan" },
                    { arrow: true },
                    { label: "Base64URL", bg: "bg-green/10", color: "text-green" },
                    { arrow: true },
                    { label: "DNS TXT", bg: "bg-yellow-500/10", color: "text-yellow-400" },
                    { arrow: true },
                    { label: "Ed25519", bg: "bg-purple-500/10", color: "text-purple-400" },
                    { arrow: true },
                    { label: "DHT", bg: "bg-pink-500/10", color: "text-pink-400" },
                  ].map((item, i) =>
                    item.arrow ? (
                      <span key={i} className="text-gray-600">→</span>
                    ) : (
                      <span key={i} className={`px-3 py-1.5 rounded-lg font-mono ${item.bg} ${item.color}`}>
                        {item.label}
                      </span>
                    )
                  )}
                </div>
              </div>
            </motion.div>
          </section>

          {/* Timing & Limits Section */}
          <section id="timing" className="mb-20">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5 }}
            >
              <h2 className="text-2xl sm:text-3xl font-mono font-bold mb-4">
                Timing & Limits
              </h2>
              
              <p className="text-gray-400 leading-relaxed mb-8">
                Protocol constraints and timing parameters for optimal performance.
              </p>

              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                {[
                  { label: "Poll (active)", value: "2s", note: "During conversation" },
                  { label: "Poll (idle)", value: "8s", note: "After 60s inactivity" },
                  { label: "Poll (call)", value: "1s", note: "During call setup" },
                  { label: "Republish", value: "30m", note: "DHT refresh interval" },
                  { label: "Record TTL", value: "300s", note: "DNS TTL value" },
                  { label: "Max message", value: "500B", note: "Single message limit" },
                  { label: "Max payload", value: "800", note: "Base64 chars (_msgs)" },
                  { label: "Packet warn", value: "1KB", note: "DHT size warning" },
                ].map((item, i) => (
                  <motion.div
                    key={item.label}
                    initial={{ opacity: 0, scale: 0.95 }}
                    whileInView={{ opacity: 1, scale: 1 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.3, delay: i * 0.03 }}
                    className="rounded-xl border border-border/50 bg-surface p-4 text-center"
                  >
                    <div className="text-xs font-mono text-gray-500 mb-2">{item.label}</div>
                    <div className="text-2xl font-mono font-bold text-gradient mb-1">{item.value}</div>
                    <div className="text-xs text-gray-600">{item.note}</div>
                  </motion.div>
                ))}
              </div>
            </motion.div>
          </section>

          {/* Technical FAQ Section */}
          <section id="technical-faq" className="mb-20">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5 }}
            >
              <h2 className="text-2xl sm:text-3xl font-mono font-bold mb-4">
                Technical FAQ
              </h2>
              
              <p className="text-gray-400 leading-relaxed mb-8">
                Design decisions and rationale behind the protocol choices.
              </p>

              <div className="space-y-4">
                {[
                  {
                    q: "Why Mainline DHT instead of a custom P2P network?",
                    a: "The Mainline DHT is the largest deployed DHT in the world with 10M+ active nodes. By leveraging existing infrastructure, we get instant global reach, battle-tested reliability, and no bootstrap problem. Users don't need to wait for network effects — the network already exists.",
                    tags: ["Infrastructure", "Scale"],
                  },
                  {
                    q: "Why Pkarr over direct BEP44?",
                    a: "Pkarr provides a clean abstraction over BEP44 mutable items using DNS packet format. This gives us familiar semantics (TXT records), built-in TTL handling, and the ability to store multiple records per keypair. The DNS format also opens doors for future DNS-over-DHT resolution.",
                    tags: ["Abstraction", "Extensibility"],
                  },
                  {
                    q: "Why Ed25519 for signing?",
                    a: "Ed25519 offers small keys (32 bytes), fast signing/verification, and is required by BEP44. It's also deterministic (same message + key = same signature), which simplifies implementation. The z-base-32 encoding produces human-readable public keys that work as identifiers.",
                    tags: ["Performance", "Compatibility"],
                  },
                  {
                    q: "Why NaCl secretbox (XSalsa20-Poly1305) for encryption?",
                    a: "Secretbox is an authenticated encryption scheme that's simple, fast, and hard to misuse. The 24-byte nonce eliminates IV reuse concerns with random generation. It's also available in every language via libsodium bindings, ensuring cross-platform compatibility.",
                    tags: ["Security", "Simplicity"],
                  },
                  {
                    q: "Why symmetric encryption instead of asymmetric (like NaCl box)?",
                    a: "A shared symmetric key allows both parties to decrypt without knowing each other's private keys upfront. The invite link contains the shared key, enabling instant secure communication. This also keeps messages smaller since there's no per-message key exchange overhead.",
                    tags: ["UX", "Efficiency"],
                  },
                  {
                    q: "Why two keypairs per chat instead of one shared keypair?",
                    a: "Each party signing their own records prevents impersonation — you can only write to your own keypair. This creates two unidirectional channels that together form the bidirectional chat. It also allows for independent message timing and acknowledgments.",
                    tags: ["Security", "Non-repudiation"],
                  },
                  {
                    q: "Why DNS TXT records for storage format?",
                    a: "DNS packets are well-defined, compact, and universally understood. TXT records can hold arbitrary data, multiple records fit in one packet, and the format includes TTL semantics. This also makes the protocol compatible with existing DNS tooling for debugging.",
                    tags: ["Interoperability", "Debugging"],
                  },
                  {
                    q: "Why polling instead of push notifications?",
                    a: "The DHT doesn't support subscriptions or push — it's a key-value store. Polling is the only option, but we optimize with adaptive intervals: 2s when active, 8s when idle, 1s during calls. This balances responsiveness with DHT load.",
                    tags: ["DHT Constraints", "Optimization"],
                  },
                  {
                    q: "Why are messages ephemeral (no persistence)?",
                    a: "DHT records expire naturally (~2 hours without republishing). This is a feature, not a bug — messages vanish when you stop the app. For users wanting persistence, messages are stored locally. The ephemeral nature provides plausible deniability.",
                    tags: ["Privacy", "Ephemerality"],
                  },
                  {
                    q: "Why 500 bytes max per message?",
                    a: "BEP44 has a ~1000 byte limit per mutable item. After encryption overhead, nonce, base64 encoding, and other records (_ts, _ack, _nick, _call), we have ~800 chars for the _msgs payload. 500 bytes per message allows batching multiple messages while staying under limits.",
                    tags: ["DHT Constraints", "Batching"],
                  },
                  {
                    q: "Why WebRTC for calls instead of the DHT?",
                    a: "Real-time audio/video requires low latency that the DHT can't provide. WebRTC gives us direct peer-to-peer media streams with SRTP encryption. The DHT is only used for signaling (exchanging SDP/ICE) — once connected, media flows directly between peers.",
                    tags: ["Real-time", "Performance"],
                  },
                  {
                    q: "Why compress SDP in call signals?",
                    a: "Full SDP offers are 2-4KB, far exceeding DHT limits. We extract only essential fields (ufrag, pwd, fingerprint, candidates, codecs) and reconstruct a minimal SDP on the other side. This fits signaling in ~500 bytes while maintaining compatibility.",
                    tags: ["DHT Constraints", "Compression"],
                  },
                  {
                    q: "Why include timestamps in call signals?",
                    a: "The timestamp (ts) field resolves 'glare' — when both parties call each other simultaneously. The lower timestamp wins and becomes the caller. This deterministic resolution prevents deadlocks without requiring coordination.",
                    tags: ["Conflict Resolution", "Determinism"],
                  },
                  {
                    q: "Why z-base-32 for public key encoding?",
                    a: "z-base-32 produces DNS-safe strings (no special characters), is case-insensitive, and slightly more compact than hex. It's the standard encoding for Pkarr keys and produces memorable-ish identifiers like 'ybndrfg8ejkmcpqxot1uwisza345h769'.",
                    tags: ["Encoding", "DNS Compatibility"],
                  },
                  {
                    q: "Why base64url for encrypted payloads?",
                    a: "base64url is URL-safe (no +/= characters), works in DNS TXT records, and is more compact than hex. The 'url' variant avoids issues with special characters in invite links and DNS parsing.",
                    tags: ["Encoding", "URL Safety"],
                  },
                ].map((faq, i) => (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, y: 10 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.3, delay: i * 0.02 }}
                    className="rounded-xl border border-border/50 bg-surface overflow-hidden"
                  >
                    <details className="group">
                      <summary className="px-6 py-4 cursor-pointer flex items-start gap-4 hover:bg-surface-light/50 transition-colors">
                        <span className="text-cyan mt-1 group-open:rotate-90 transition-transform">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                          </svg>
                        </span>
                        <div className="flex-1">
                          <span className="font-medium text-gray-100">{faq.q}</span>
                          <div className="flex flex-wrap gap-2 mt-2">
                            {faq.tags.map((tag) => (
                              <span
                                key={tag}
                                className="text-xs px-2 py-0.5 rounded-full bg-cyan/10 text-cyan/80"
                              >
                                {tag}
                              </span>
                            ))}
                          </div>
                        </div>
                      </summary>
                      <div className="px-6 pb-5 pl-14">
                        <p className="text-gray-400 text-sm leading-relaxed">
                          {faq.a}
                        </p>
                      </div>
                    </details>
                  </motion.div>
                ))}
              </div>
            </motion.div>
          </section>

          {/* Footer CTA */}
          <section className="text-center py-12 border-t border-border/50">
            <h3 className="text-xl font-mono font-bold mb-4">
              Ready to <span className="text-gradient">build</span>?
            </h3>
            <p className="text-gray-500 mb-6">
              The protocol is open and permissionless.
            </p>
            <div className="flex justify-center gap-4">
              <a
                href="https://github.com/MiguelMedeiros/ghostly"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-cyan/10 text-cyan font-medium border border-cyan/20 hover:bg-cyan/20 transition-colors"
              >
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                </svg>
                View Source
              </a>
              <a
                href="/"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-surface text-gray-300 font-medium border border-border/50 hover:border-gray-500 transition-colors"
              >
                ← Back to Home
              </a>
            </div>
          </section>
        </div>
        </main>
      </div>
    </div>
  );
}
