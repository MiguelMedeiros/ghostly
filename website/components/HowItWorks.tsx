"use client";

import { motion } from "motion/react";

const steps = [
  {
    number: "01",
    title: "Create a Chat",
    description:
      "The app generates two Ed25519 keypairs and one 256-bit symmetric encryption key. One keypair is yours to write, the other is for your peer. No server involved.",
    visual: (
      <div className="font-mono text-xs space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-cyan">keypairA</span>
          <span className="text-gray-600">=</span>
          <span className="text-green">Ed25519.generate()</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-cyan">keypairB</span>
          <span className="text-gray-600">=</span>
          <span className="text-green">Ed25519.generate()</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-cyan">encKey</span>
          <span className="text-gray-600">=</span>
          <span className="text-yellow-400">random(32 bytes)</span>
        </div>
        <div className="mt-3 pt-3 border-t border-border/50 text-gray-500">
          <span className="text-gray-400">// Two channels, one shared secret</span>
        </div>
      </div>
    ),
  },
  {
    number: "02",
    title: "Share the Link",
    description:
      "The invite URL contains everything your peer needs: their writing seed, your public key, and the shared encryption key — all in the URL fragment, which never leaves the browser.",
    visual: (
      <div className="font-mono text-xs">
        <div className="text-gray-500 mb-2">Invite URL:</div>
        <div className="bg-[#0d1117] rounded-lg p-3 border border-border/50 break-all">
          <span className="text-gray-500">app://</span>
          <span className="text-gray-400">#/chat/</span>
          <span className="text-cyan">seed_b64</span>
          <span className="text-gray-500">/</span>
          <span className="text-green">peer_pk_b64</span>
          <span className="text-gray-500">/</span>
          <span className="text-yellow-400">enc_key_b64</span>
        </div>
        <div className="mt-2 flex items-center gap-1.5 text-gray-500">
          <svg className="w-3 h-3 text-green" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
          </svg>
          Fragment never sent to any server
        </div>
      </div>
    ),
  },
  {
    number: "03",
    title: "Messages Travel the DHT",
    description:
      "Each message is encrypted with NaCl secretbox, packed into a DNS TXT record, Ed25519-signed, and published to the Mainline DHT via Pkarr. Your peer polls the DHT to receive.",
    visual: (
      <div className="font-mono text-xs space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="px-2 py-1 rounded bg-surface-light text-gray-300">plaintext</span>
          <span className="text-gray-600">→</span>
          <span className="px-2 py-1 rounded bg-cyan/10 text-cyan">encrypt</span>
          <span className="text-gray-600">→</span>
          <span className="px-2 py-1 rounded bg-surface-light text-gray-300">DNS TXT</span>
          <span className="text-gray-600">→</span>
          <span className="px-2 py-1 rounded bg-green/10 text-green">sign</span>
          <span className="text-gray-600">→</span>
          <span className="px-2 py-1 rounded bg-yellow-500/10 text-yellow-400">DHT</span>
        </div>
        <div className="flex items-center gap-3 text-gray-500">
          <div className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-cyan pulse-dot" />
            XSalsa20-Poly1305
          </div>
          <div className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-green pulse-dot" />
            Ed25519
          </div>
          <div className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 pulse-dot" />
            BEP44
          </div>
        </div>
      </div>
    ),
  },
  {
    number: "04",
    title: "Messages Expire",
    description:
      "Messages are kept alive by periodic republishing. Stop republishing (close the app or delete the chat) and they naturally expire from the DHT in approximately 5 hours.",
    visual: (
      <div className="font-mono text-xs space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-green">● Publishing</span>
          <span className="text-gray-600">→</span>
          <span className="text-gray-400">alive on DHT</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-yellow-400">● Stop</span>
          <span className="text-gray-600">→</span>
          <span className="text-gray-400">TTL countdown (~5h)</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-gray-500">● Expired</span>
          <span className="text-gray-600">→</span>
          <span className="text-gray-500 line-through">messages gone</span>
        </div>
        <div className="mt-2 pt-2 border-t border-border/50">
          <span className="text-gray-500">No data persists. No trace remains.</span>
        </div>
      </div>
    ),
  },
];

const containerVariants = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.2 },
  },
};

const stepVariants = {
  hidden: { opacity: 0, x: -30 },
  visible: { opacity: 1, x: 0, transition: { duration: 0.6, ease: "easeOut" as const } },
};

export function HowItWorks() {
  return (
    <section id="how-it-works" className="relative py-32 px-6">
      <div className="absolute inset-0 bg-linear-to-b from-transparent via-cyan/[0.02] to-transparent" />

      <div className="relative max-w-5xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
          className="text-center mb-20"
        >
          <span className="inline-block font-mono text-sm text-cyan mb-4 tracking-wider uppercase">
            Protocol
          </span>
          <h2 className="text-4xl sm:text-5xl font-mono font-bold mb-6">
            How It <span className="text-gradient">Works</span>
          </h2>
          <p className="text-lg text-gray-400 max-w-xl mx-auto">
            Four steps. No middlemen. Pure cryptography and the decentralized web.
          </p>
        </motion.div>

        <motion.div
          variants={containerVariants}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-50px" }}
          className="relative"
        >
          <div className="absolute left-8 top-0 bottom-0 w-px bg-linear-to-b from-cyan/40 via-green/40 to-transparent hidden lg:block" />
          <div className="absolute left-8 top-0 bottom-0 w-px bg-linear-to-b from-cyan/10 via-green/10 to-transparent blur-sm hidden lg:block" />

          <div className="space-y-12">
            {steps.map((step) => (
              <motion.div
                key={step.number}
                variants={stepVariants}
                className="relative grid grid-cols-1 lg:grid-cols-[1fr_1fr] gap-8 items-start"
              >
                <div className="lg:pl-20">
                  <div className="flex items-center gap-4 mb-4">
                    <div className="relative z-10 w-16 h-16 rounded-2xl bg-surface border border-border/50 flex items-center justify-center">
                      <span className="font-mono text-2xl font-bold text-gradient">
                        {step.number}
                      </span>
                    </div>
                    <h3 className="text-2xl font-mono font-bold text-gray-100">
                      {step.title}
                    </h3>
                  </div>
                  <p className="text-gray-400 leading-relaxed ml-0 lg:ml-20">
                    {step.description}
                  </p>
                </div>

                <div className="rounded-xl border border-border/50 bg-surface p-6 hover:border-cyan/20 transition-colors">
                  {step.visual}
                </div>
              </motion.div>
            ))}
          </div>
        </motion.div>
      </div>
    </section>
  );
}
