"use client";

import { motion } from "motion/react";

export function ProtocolDeepDive() {
  return (
    <section id="protocol" className="relative py-32 px-6">
      <div className="absolute inset-0 bg-linear-to-b from-transparent via-green/[0.02] to-transparent" />

      <div className="relative max-w-5xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
          className="text-center mb-20"
        >
          <span className="inline-block font-mono text-sm text-green mb-4 tracking-wider uppercase">
            Under the Hood
          </span>
          <h2 className="text-4xl sm:text-5xl font-mono font-bold mb-6">
            Protocol <span className="text-gradient">Deep Dive</span>
          </h2>
          <p className="text-lg text-gray-400 max-w-2xl mx-auto">
            For the curious and the cryptographers. Here&apos;s exactly what happens
            when you send a message.
          </p>
        </motion.div>

        <div className="space-y-16">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
            className="rounded-2xl border border-border/50 bg-surface overflow-hidden"
          >
            <div className="px-8 py-5 border-b border-border/50">
              <h3 className="text-xl font-mono font-bold text-gray-100">
                Two-Channel Architecture
              </h3>
            </div>
            <div className="p-8">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                <div className="space-y-4">
                  <p className="text-gray-400 leading-relaxed">
                    Each chat uses <strong className="text-gray-200">two independent Pkarr keypairs</strong> and
                    one <strong className="text-gray-200">shared symmetric key</strong>. This creates two
                    unidirectional channels — each party writes to their own key
                    and reads from the other&apos;s.
                  </p>
                  <p className="text-gray-400 leading-relaxed">
                    This means neither party can impersonate the other — you can
                    only sign records with your own private key. The shared
                    encryption key ensures only the two participants can read the
                    content.
                  </p>
                </div>
                <div className="bg-[#060a10] rounded-xl p-6 font-mono text-sm">
                  <div className="space-y-4">
                    <div className="flex items-start gap-3">
                      <div className="w-20 text-right text-gray-600 shrink-0">Alice</div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-cyan">writes →</span>
                          <span className="text-gray-300">keypairA</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-green">reads  ←</span>
                          <span className="text-gray-300">keypairB</span>
                        </div>
                      </div>
                    </div>
                    <div className="border-t border-border/30 my-2" />
                    <div className="flex items-start gap-3">
                      <div className="w-20 text-right text-gray-600 shrink-0">Bob</div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-cyan">writes →</span>
                          <span className="text-gray-300">keypairB</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-green">reads  ←</span>
                          <span className="text-gray-300">keypairA</span>
                        </div>
                      </div>
                    </div>
                    <div className="border-t border-border/30 my-2" />
                    <div className="flex items-center gap-3">
                      <div className="w-20 text-right text-gray-600 shrink-0">Shared</div>
                      <div className="flex items-center gap-2">
                        <span className="text-yellow-400">encKey</span>
                        <span className="text-gray-600">=</span>
                        <span className="text-gray-400">256-bit symmetric</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
            className="rounded-2xl border border-border/50 bg-surface overflow-hidden"
          >
            <div className="px-8 py-5 border-b border-border/50">
              <h3 className="text-xl font-mono font-bold text-gray-100">
                Encryption Pipeline
              </h3>
            </div>
            <div className="p-8">
              <div className="flex flex-wrap items-center justify-center gap-3 mb-8">
                {[
                  { label: "Plaintext", color: "text-gray-300", bg: "bg-surface-light" },
                  { label: "→" },
                  { label: "NaCl secretbox", color: "text-cyan", bg: "bg-cyan/10" },
                  { label: "→" },
                  { label: "Base64", color: "text-gray-300", bg: "bg-surface-light" },
                  { label: "→" },
                  { label: "DNS TXT Record", color: "text-green", bg: "bg-green/10" },
                  { label: "→" },
                  { label: "Ed25519 Sign", color: "text-yellow-400", bg: "bg-yellow-500/10" },
                  { label: "→" },
                  { label: "Mainline DHT", color: "text-purple-400", bg: "bg-purple-500/10" },
                ].map((item, i) =>
                  item.bg ? (
                    <motion.span
                      key={i}
                      initial={{ opacity: 0, scale: 0.8 }}
                      whileInView={{ opacity: 1, scale: 1 }}
                      viewport={{ once: true }}
                      transition={{ delay: i * 0.08, duration: 0.3 }}
                      className={`px-4 py-2 rounded-lg ${item.bg} ${item.color} text-sm font-mono font-medium`}
                    >
                      {item.label}
                    </motion.span>
                  ) : (
                    <span key={i} className="text-gray-600 text-lg">
                      {item.label}
                    </span>
                  )
                )}
              </div>
              <div className="bg-[#060a10] rounded-xl p-6 font-mono text-xs sm:text-sm overflow-x-auto">
                <div className="text-gray-500 mb-2">
                  {"// What a published Pkarr record looks like"}
                </div>
                <div>
                  <span className="text-cyan">_msgs</span>
                  <span className="text-gray-600"> TXT </span>
                  <span className="text-green">
                    &quot;nonce_b64+ciphertext_b64&quot;
                  </span>
                </div>
                <div>
                  <span className="text-cyan">_ts</span>
                  <span className="text-gray-600">{"   "}TXT </span>
                  <span className="text-yellow-400">&quot;1708894521000&quot;</span>
                </div>
                <div>
                  <span className="text-cyan">_ack</span>
                  <span className="text-gray-600">{"  "}TXT </span>
                  <span className="text-yellow-400">&quot;1708894518000&quot;</span>
                </div>
                <div>
                  <span className="text-cyan">_nick</span>
                  <span className="text-gray-600">{" "}TXT </span>
                  <span className="text-green">
                    &quot;encrypted_nickname_b64&quot;
                  </span>
                </div>
                <div className="mt-3 pt-3 border-t border-border/30 text-gray-600">
                  {"// Signed with Ed25519, stored via BEP44 mutable items"}
                </div>
              </div>
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
            className="rounded-2xl border border-border/50 bg-surface overflow-hidden"
          >
            <div className="px-8 py-5 border-b border-border/50">
              <h3 className="text-xl font-mono font-bold text-gray-100">
                The Stack
              </h3>
            </div>
            <div className="p-8">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {[
                  {
                    name: "Pkarr",
                    description: "Public Key Addressable Resource Records. DNS packets signed with Ed25519 and published to the DHT.",
                    link: "https://pkarr.org",
                  },
                  {
                    name: "BEP44",
                    description: "BitTorrent Extension Protocol for mutable items in the DHT. The transport layer for signed records.",
                    link: "https://www.bittorrent.org/beps/bep_0044.html",
                  },
                  {
                    name: "Ed25519",
                    description: "Elliptic curve digital signature algorithm. Used to sign Pkarr packets and prove authorship.",
                    link: null,
                  },
                  {
                    name: "NaCl",
                    description: "Networking and Cryptography library. XSalsa20-Poly1305 authenticated encryption for message content.",
                    link: null,
                  },
                ].map((item, i) => (
                  <motion.div
                    key={item.name}
                    initial={{ opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ delay: i * 0.1, duration: 0.5 }}
                    className="rounded-xl border border-border/50 bg-[#060a10] p-5 hover:border-green/30 transition-colors"
                  >
                    <div className="flex items-center justify-between mb-3">
                      <span className="font-mono font-bold text-lg text-gradient">
                        {item.name}
                      </span>
                      {item.link && (
                        <a
                          href={item.link}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-gray-600 hover:text-cyan transition-colors"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                          </svg>
                        </a>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 leading-relaxed">
                      {item.description}
                    </p>
                  </motion.div>
                ))}
              </div>
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
