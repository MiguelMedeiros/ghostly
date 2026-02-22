"use client";

import { motion } from "motion/react";

const commands = [
  {
    name: "identity new",
    description: "Create a new identity (keypair + shared key)",
    usage: "ghostly-cli identity new",
    output: '{"seed":"...","pubkey":"pk:...","shared_key":"..."}',
    flags: [],
  },
  {
    name: "invite new",
    description: "Generate an invite URL for others to connect",
    usage: "ghostly-cli invite new --seed <SEED> [--key <KEY>]",
    output: '{"invite_url":"ghost://...","pubkey":"pk:..."}',
    flags: [
      { name: "--seed", required: true, description: "Your seed (base64url)" },
      { name: "--key", required: false, description: "Shared key (generates new if not provided)" },
    ],
  },
  {
    name: "invite parse",
    description: "Parse an invite URL and generate your keypair",
    usage: "ghostly-cli invite parse <URL>",
    output: '{"peer_pubkey":"...","shared_key":"...","my_seed":"...","my_pubkey":"..."}',
    flags: [],
  },
  {
    name: "send",
    description: "Send an encrypted message",
    usage: 'ghostly-cli send --seed <SEED> --peer <PEER> --key <KEY> "message"',
    output: '{"ok":true,"timestamp":1234567890,"messages_kept":1}',
    flags: [
      { name: "--seed", required: true, description: "Your seed (base64url)" },
      { name: "--peer", required: true, description: "Peer's public key (z32)" },
      { name: "--key", required: true, description: "Shared encryption key" },
      { name: "--nick", required: false, description: "Your nickname" },
      { name: "--stdin", required: false, description: "Read message from stdin" },
    ],
  },
  {
    name: "recv",
    description: "Receive messages (single poll)",
    usage: "ghostly-cli recv --peer <PEER> --key <KEY>",
    output: '{"messages":[...],"peer_ack":123,"latest_ts":456,"message_count":2}',
    flags: [
      { name: "--peer", required: true, description: "Peer's public key (z32)" },
      { name: "--key", required: true, description: "Shared encryption key" },
    ],
  },
  {
    name: "watch",
    description: "Watch for new messages (streaming mode)",
    usage: "ghostly-cli watch --seed <SEED> --peer <PEER> --key <KEY>",
    output: 'NDJSON stream: {"from":"peer","text":"...","timestamp":123}',
    flags: [
      { name: "--seed", required: true, description: "Your seed (base64url)" },
      { name: "--peer", required: true, description: "Peer's public key (z32)" },
      { name: "--key", required: true, description: "Shared encryption key" },
      { name: "--nick", required: false, description: "Your nickname" },
      { name: "--poll-interval", required: false, description: "Poll interval in ms (default: 2000)" },
      { name: "--ack", required: false, description: "ACK messages automatically (default: true)" },
    ],
  },
];

export function CLIReference() {
  return (
    <section id="reference" className="py-24 px-6">
      <div className="max-w-5xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-center mb-16"
        >
          <h2 className="font-mono text-4xl font-bold mb-4">
            <span className="text-gradient">Command Reference</span>
          </h2>
          <p className="text-gray-400 text-lg">
            All available commands and their options
          </p>
        </motion.div>

        <div className="space-y-6">
          {commands.map((cmd, i) => (
            <motion.div
              key={cmd.name}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.05 }}
              className="bg-[#0d1117] border border-border rounded-xl overflow-hidden"
            >
              <div className="p-5 border-b border-border">
                <div className="flex flex-wrap items-center gap-3 mb-2">
                  <code className="text-lg font-mono font-semibold text-cyan">
                    ghostly-cli {cmd.name}
                  </code>
                </div>
                <p className="text-gray-400">{cmd.description}</p>
              </div>
              
              <div className="p-5 space-y-4">
                <div>
                  <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">Usage</div>
                  <code className="text-sm font-mono text-green bg-green/10 px-3 py-1.5 rounded-lg block overflow-x-auto">
                    {cmd.usage}
                  </code>
                </div>

                {cmd.flags.length > 0 && (
                  <div>
                    <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">Flags</div>
                    <div className="space-y-2">
                      {cmd.flags.map((flag) => (
                        <div key={flag.name} className="flex items-start gap-3 text-sm">
                          <code className="font-mono text-cyan shrink-0">{flag.name}</code>
                          {flag.required && (
                            <span className="text-xs px-1.5 py-0.5 rounded bg-red-500/20 text-red-400">required</span>
                          )}
                          <span className="text-gray-400">{flag.description}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div>
                  <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">Output</div>
                  <code className="text-xs font-mono text-gray-400 bg-black/30 px-3 py-2 rounded-lg block overflow-x-auto">
                    {cmd.output}
                  </code>
                </div>
              </div>
            </motion.div>
          ))}
        </div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="mt-12 p-6 bg-cyan/5 border border-cyan/20 rounded-xl"
        >
          <h3 className="text-lg font-semibold text-cyan mb-3">Global Flags</h3>
          <div className="space-y-2 text-sm">
            <div className="flex items-start gap-3">
              <code className="font-mono text-cyan shrink-0">--json</code>
              <span className="text-gray-400">Output JSON (default: true)</span>
            </div>
            <div className="flex items-start gap-3">
              <code className="font-mono text-cyan shrink-0">--quiet, -q</code>
              <span className="text-gray-400">Suppress extra output</span>
            </div>
            <div className="flex items-start gap-3">
              <code className="font-mono text-cyan shrink-0">--help, -h</code>
              <span className="text-gray-400">Show help information</span>
            </div>
            <div className="flex items-start gap-3">
              <code className="font-mono text-cyan shrink-0">--version, -V</code>
              <span className="text-gray-400">Show version</span>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
