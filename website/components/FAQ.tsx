"use client";

import { motion } from "motion/react";
import { useState } from "react";

const faqs = [
  {
    question: "What is Ghostly?",
    answer:
      "Ghostly is an ephemeral, peer-to-peer service layer that started as a messenger. You and your contacts find each other through the Mainline DHT (BitTorrent's distributed hash table, 10+ million nodes), connect directly over WebRTC, and then chat, call, send files and sats, or open each other's local web apps. Whatever you offer exists while you are online. There are no servers and no accounts.",
  },
  {
    question: "How does sharing a localhost app work? Is it safe?",
    answer:
      "You give the app a name and its localhost address. Your contacts see the name, never the address. When one opens it, their requests travel over the encrypted WebRTC connection to your Ghostly, which forwards them only to the address you configured: loopback only, no redirects elsewhere, without your cookies, with size and rate limits. Only people you linked with can reach it, only while you are online. Still: a contact can use that app exactly as you can on localhost, so share apps you would let them use.",
  },
  {
    question: "How do the sats work? Where is my money?",
    answer:
      "Ghostly has an ecash (Cashu) wallet. You receive over Lightning through a mint, pay Lightning invoices from your balance, and send or request sats in a chat. Ecash is custodial: the mint holds the sats and could lose them. There is no seed backup yet. Keep pocket money only. The history shows the exact fee of every movement, and the wallet shows what each mint charges.",
  },
  {
    question: "Web, extension or desktop: which one?",
    answer:
      "They are the same client on the same protocol, and an invite from one works in the others. The web app needs no install but only lives while the tab is open, and a web page is not allowed to share your localhost or host a contact's app. The extension and the desktop app can do both. The desktop app also talks to the DHT directly instead of through relays.",
  },
  {
    question: "How does encryption work?",
    answer:
      "We use NaCl secretbox with XSalsa20-Poly1305 for message encryption. Each chat has a unique 256-bit encryption key that's shared via the invite link. Private keys never leave your device — not even we can read your messages.",
  },
  {
    question: "What makes messages ephemeral?",
    answer:
      "Messages are continuously republished to the DHT to stay alive. When you close the app or delete a chat, republishing stops and messages naturally expire from the network within approximately 5 hours. No server stores them permanently.",
  },
  {
    question: "Do I need to create an account?",
    answer:
      "No. Your identity is a cryptographic keypair generated locally on your device. There's no sign-up, no email, no phone number. Just open the app and start chatting.",
  },
  {
    question: "How do I start a chat with someone?",
    answer:
      "Create a new chat to get an invite code or QR code. Share it with your contact through any channel. When they join, you're connected directly through the DHT — no server involved.",
  },
  {
    question: "What is the Mainline DHT?",
    answer:
      "The Mainline DHT is BitTorrent's distributed hash table, the largest DHT in the world with over 10 million nodes. Ghostly uses Pkarr to publish encrypted messages as DNS records to this network.",
  },
  {
    question: "Can I make voice or video calls?",
    answer:
      "Yes! Ghostly supports peer-to-peer audio and video calls using WebRTC. The signaling happens through the DHT, and the actual call is a direct connection between you and your contact.",
  },
  {
    question: "What happens if I lose my device?",
    answer:
      "Since there are no accounts or central servers, your chat history only exists on your device. If you lose your device, your chats are gone. This is by design — it's the ultimate privacy protection.",
  },
  {
    question: "Is Ghostly open source?",
    answer:
      "Yes, completely. The entire codebase is available on GitHub. You can audit the code, verify the cryptography, and build from source. We believe trust is earned through transparency.",
  },
  {
    question: "What platforms does Ghostly support?",
    answer:
      "Ghostly is a desktop application built with Tauri. It runs natively on macOS, Windows, and Linux. Mobile versions may come in the future.",
  },
  {
    question: "How is this different from Signal or WhatsApp?",
    answer:
      "Unlike Signal or WhatsApp, Ghostly has no central servers, no accounts, and no permanent message storage. Messages exist only while being actively republished. It's truly serverless and ephemeral by design.",
  },
  {
    question: "Is it really free?",
    answer:
      "Yes, Ghostly is completely free and open source. There are no ads, no premium tiers, and no data collection. The only infrastructure cost is the Mainline DHT, which is maintained by the BitTorrent network.",
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
