"use client";

import { motion } from "motion/react";
import { useState } from "react";

const faqs = [
  {
    question: "What is Ghostly?",
    answer:
      "A peer to peer way to chat, call, send files and sats, and share local web apps. Everything you offer exists only while you are online. No servers, no accounts.",
  },
  {
    question: "Is sharing a localhost app safe?",
    answer:
      "Contacts see a name, never your address. Ghostly forwards their requests only to the app you picked: loopback only, no cookies, with limits. They can use that app exactly as you can, so share what you would let them use.",
  },
  {
    question: "Where are my sats?",
    answer:
      "In an ecash (Cashu) wallet. You receive and pay over Lightning through a mint. The mint holds the sats and could lose them, and there is no seed backup yet. Pocket money only.",
  },
  {
    question: "Web, extension or desktop?",
    answer:
      "Same client, same protocol. The web app needs no install but cannot share localhost or open a contact's app. The extension and desktop can. Desktop also reaches the DHT without relays.",
  },
  {
    question: "How is it encrypted?",
    answer:
      "NaCl secretbox (XSalsa20-Poly1305) with a 256-bit key per chat, shared in the invite. Keys never leave your device.",
  },
  {
    question: "Why do messages disappear?",
    answer:
      "They live on the DHT only while you republish them. Close the app and they expire in about 5 hours.",
  },
  {
    question: "Do I need an account?",
    answer:
      "No. Your identity is a keypair generated on your device. No email, no phone number.",
  },
  {
    question: "What if I lose my device?",
    answer:
      "Your chats are gone. There is no server to restore them from. That is the point.",
  },
  {
    question: "How is this different from Signal?",
    answer:
      "No central servers, no accounts, no stored messages.",
  },
  {
    question: "Is it free and open source?",
    answer:
      "Yes. No ads, no tiers, no data collection. The code is on GitHub.",
  },
];

function FAQItem({
  question,
  answer,
  isOpen,
  onToggle,
  index,
}: {
  question: string;
  answer: string;
  isOpen: boolean;
  onToggle: () => void;
  index: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-50px" }}
      transition={{ duration: 0.4, delay: index * 0.05 }}
      className="border-b border-border/50 last:border-b-0"
    >
      <button
        onClick={onToggle}
        className="w-full py-5 flex items-center justify-between gap-4 text-left cursor-pointer group"
      >
        <span className="text-base font-medium text-gray-200 group-hover:text-cyan transition-colors">
          {question}
        </span>
        <span
          className={`shrink-0 w-6 h-6 rounded-full bg-surface-light flex items-center justify-center transition-transform duration-300 ${
            isOpen ? "rotate-180" : ""
          }`}
        >
          <svg
            className="w-4 h-4 text-gray-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M19 9l-7 7-7-7"
            />
          </svg>
        </span>
      </button>
      <motion.div
        initial={false}
        animate={{
          height: isOpen ? "auto" : 0,
          opacity: isOpen ? 1 : 0,
        }}
        transition={{ duration: 0.3, ease: "easeInOut" }}
        className="overflow-hidden"
      >
        <p className="pb-5 text-sm text-gray-500 leading-relaxed">{answer}</p>
      </motion.div>
    </motion.div>
  );
}

export function FAQ() {
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  return (
    <section id="faq" className="relative py-32 px-6">
      <div className="max-w-3xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
          className="text-center mb-12"
        >
          <span className="inline-block font-mono text-sm text-cyan mb-4 tracking-wider uppercase">
            FAQ
          </span>
          <h2 className="text-4xl sm:text-5xl font-mono font-bold mb-6">
            Frequently asked{" "}
            <span className="text-gradient">questions</span>
          </h2>
          <p className="text-lg text-gray-400 max-w-xl mx-auto">
            Everything you need to know about Ghostly.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.2 }}
          className="bg-surface rounded-2xl border border-border/50 px-6 divide-y divide-border/50"
        >
          {faqs.map((faq, index) => (
            <FAQItem
              key={index}
              question={faq.question}
              answer={faq.answer}
              isOpen={openIndex === index}
              onToggle={() =>
                setOpenIndex(openIndex === index ? null : index)
              }
              index={index}
            />
          ))}
        </motion.div>
      </div>
    </section>
  );
}
