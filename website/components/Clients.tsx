"use client";

import { motion } from "motion/react";
import { IconTile, type IconName } from "./icons";

const clients: { name: string; icon: IconName; pitch: string; cta: { label: string; href: string }; note: string }[] = [
  {
    name: "Web",
    icon: "globe",
    pitch: "Nothing to install. Open a tab and you are a ghost until you close it.",
    cta: { label: "Open app.ghostly.tools", href: "https://app.ghostly.tools" },
    note: "Beta",
  },
  {
    name: "Browser extension",
    icon: "puzzle",
    pitch: "Lives in Chrome and keeps haunting while the browser is open. Shares your localhost.",
    cta: { label: "Get the extension", href: "#extension" },
    note: "Chromium",
  },
  {
    name: "Desktop",
    icon: "desktop",
    pitch: "The full ghost. Talks to the DHT directly, shares local apps with cookies and all.",
    cta: { label: "Download", href: "#download" },
    note: "Mac · Win · Linux",
  },
  {
    name: "CLI",
    icon: "terminal",
    pitch: "For bots and scripts that want to whisper through the DHT.",
    cta: { label: "cargo install ghostly-cli", href: "/cli" },
    note: "Rust",
  },
];

const rows: [string, boolean[]][] = [
  ["Chat, voice & video", [true, true, true, false]],
  ["Text chat from scripts", [false, false, false, true]],
  ["Files and sats", [true, true, true, false]],
  ["Open a contact's web app", [false, true, true, false]],
  ["Share a localhost app", [false, true, true, false]],
  ["Reaches the DHT without relays", [false, false, true, true]],
  ["Keeps running with no window open", [false, true, false, true]],
];

export function Clients() {
  return (
    <section id="clients" className="relative py-24 px-6">
      <div className="max-w-5xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
          className="text-center mb-12"
        >
          <h2 className="text-4xl sm:text-5xl font-mono font-bold mb-6">
            Pick your <span className="text-gradient">ghost</span>
          </h2>
          <p className="text-lg text-gray-400 max-w-2xl mx-auto">
            Four bodies, one spirit. They speak the same protocol and an invite from one works in any other.
          </p>
        </motion.div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-10">
          {clients.map((client, index) => (
            <motion.div
              key={client.name}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-50px" }}
              transition={{ duration: 0.4, delay: index * 0.08 }}
              className="rounded-xl border border-border/50 bg-surface p-5 flex flex-col hover:border-cyan/40 transition-colors"
            >
              <div className="flex items-center justify-between gap-2 mb-4">
                <IconTile name={client.icon} />
                <span className="text-[10px] font-mono uppercase tracking-wider text-gray-500 border border-border/50 rounded-full px-2 py-0.5 whitespace-nowrap">
                  {client.note}
                </span>
              </div>
              <h3 className="font-mono font-bold text-gray-100 mb-2">{client.name}</h3>
              <p className="text-sm text-gray-500 leading-relaxed flex-1">{client.pitch}</p>
              <a href={client.cta.href} className="mt-4 text-sm font-semibold text-cyan hover:text-green transition-colors">
                {client.cta.label} →
              </a>
            </motion.div>
          ))}
        </div>

        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          className="overflow-x-auto rounded-xl border border-border/50 bg-surface"
        >
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 font-mono text-xs uppercase tracking-wider">
                <th className="p-3 font-normal">What it can do</th>
                {clients.map((c) => (
                  <th key={c.name} className="p-3 font-normal text-center">{c.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(([label, cells]) => (
                <tr key={label} className="border-t border-border/40">
                  <td className="p-3 text-gray-300">{label}</td>
                  {cells.map((yes, i) => (
                    <td key={i} className={`p-3 text-center ${yes ? "text-green" : "text-gray-700"}`}>{yes ? "●" : "—"}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </motion.div>
        <p className="text-xs text-gray-600 text-center mt-4">
          A web page cannot reach your machine or give a contact&apos;s app a home of its own. Browsers forbid it, and they are right.
          That is what the extension and the desktop app are for.
        </p>
      </div>
    </section>
  );
}
