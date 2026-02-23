"use client";

import { motion } from "motion/react";
import { useState } from "react";

function CopyButton({ text, large = false }: { text: string; large?: boolean }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (large) {
    return (
      <button
        onClick={handleCopy}
        className="flex items-center gap-2 px-6 py-3 rounded-xl bg-green/20 text-green font-medium border border-green/30 hover:bg-green/30 transition-all hover:scale-105"
      >
        {copied ? (
          <>
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            Copied!
          </>
        ) : (
          <>
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            Copy Command
          </>
        )}
      </button>
    );
  }

  return (
    <button
      onClick={handleCopy}
      className="p-2 rounded-lg bg-white/5 hover:bg-white/10 transition-colors"
      title="Copy to clipboard"
    >
      {copied ? (
        <svg className="w-4 h-4 text-green" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      ) : (
        <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
      )}
    </button>
  );
}

const codexCommand = `curl -fsSL https://raw.githubusercontent.com/MiguelMedeiros/ghostly/main/cli/SKILL.md \\
  -o ~/.codex/skills/ghostly-cli/SKILL.md`;

const cursorCommand = `curl -fsSL https://raw.githubusercontent.com/MiguelMedeiros/ghostly/main/cli/SKILL.md \\
  -o ~/.cursor/skills/ghostly-cli/SKILL.md`;

function LockIcon() {
  return (
    <svg className="w-8 h-8 text-cyan" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
    </svg>
  );
}

function GhostIcon() {
  return (
    <svg className="w-8 h-8 text-cyan" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2C7.582 2 4 5.582 4 10v8c0 .75.6 1 1 .6l2-1.6 2 1.6c.4.3.8.3 1.2 0L12 17l1.8 1.6c.4.3.8.3 1.2 0l2-1.6 2 1.6c.4.4 1 .15 1-.6v-8c0-4.418-3.582-8-8-8z"/>
      <circle cx="9" cy="9" r="1.5" className="fill-[#0d1117]"/>
      <circle cx="15" cy="9" r="1.5" className="fill-[#0d1117]"/>
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg className="w-8 h-8 text-cyan" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418" />
    </svg>
  );
}

function BracesIcon() {
  return (
    <svg className="w-8 h-8 text-cyan" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
    </svg>
  );
}

const features = [
  {
    icon: <LockIcon />,
    title: "End-to-End Encrypted",
    description: "Messages encrypted with NaCl secretbox before leaving your machine",
  },
  {
    icon: <GhostIcon />,
    title: "Ephemeral",
    description: "Messages vanish from the DHT — no permanent traces",
  },
  {
    icon: <GlobeIcon />,
    title: "No Servers",
    description: "Direct P2P via 10M+ DHT nodes — no middleman",
  },
  {
    icon: <BracesIcon />,
    title: "JSON Output",
    description: "Perfect for AI agents — structured JSON responses",
  },
];

export function CLISkillInstall() {
  return (
    <section id="openclaw" className="py-24 px-6 relative overflow-hidden">
      {/* Background gradient */}
      <div className="absolute inset-0 bg-gradient-to-b from-[#060a10] via-[#0a1628] to-[#060a10]" />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-green/5 rounded-full blur-3xl" />
      
      <div className="max-w-5xl mx-auto relative z-10">
        {/* Hero section */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-center mb-16"
        >
          <div className="inline-flex items-center gap-3 px-5 py-2 rounded-full border border-green/30 bg-green/10 text-green mb-8">
            <span className="text-2xl">🦞</span>
            <span className="font-mono font-medium">OpenClaw Integration</span>
          </div>
          
          <h2 className="font-mono text-4xl sm:text-5xl font-bold mb-6">
            Give Your AI Agent{" "}
            <span className="text-gradient-animated">Superpowers</span>
          </h2>
          
          <p className="text-xl text-gray-400 max-w-2xl mx-auto mb-4">
            Let OpenClaw send encrypted, ephemeral messages on your behalf.
            One command. Instant privacy.
          </p>
        </motion.div>

        {/* Main install card */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ delay: 0.2 }}
          className="bg-[#0d1117] border-2 border-green/20 rounded-3xl p-8 sm:p-10 mb-16 relative"
        >
          <div className="absolute -top-4 left-1/2 -translate-x-1/2 px-4 py-1.5 rounded-full bg-green text-black text-sm font-bold">
            ONE-LINER INSTALL
          </div>

          <div className="text-center mb-8">
            <h3 className="text-2xl font-bold text-white mb-2">
              Install the Skill
            </h3>
            <p className="text-gray-400">
              Run this command to teach your agent how to use Ghost protocol
            </p>
          </div>

          {/* OpenClaw / Codex */}
          <div className="mb-6">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-gray-400 text-sm font-mono">#</span>
              <span className="text-gray-300 text-sm font-medium">OpenClaw / Codex</span>
            </div>
            <div className="bg-black/50 rounded-xl p-4 relative group">
              <pre className="overflow-x-auto">
                <code className="text-sm font-mono">
                  <span className="text-green">curl</span>{" "}
                  <span className="text-cyan">-fsSL</span>{" "}
                  <span className="text-gray-300 break-all">
                    https://raw.githubusercontent.com/MiguelMedeiros/ghostly/main/cli/SKILL.md
                  </span>{" "}
                  <span className="text-gray-500">\</span>
                  {"\n"}
                  {"  "}<span className="text-cyan">-o</span>{" "}
                  <span className="text-yellow-400">~/.codex/skills/ghostly-cli/SKILL.md</span>
                </code>
              </pre>
              <div className="absolute top-3 right-3">
                <CopyButton text={codexCommand} />
              </div>
            </div>
          </div>

          {/* Cursor */}
          <div className="mb-8">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-gray-400 text-sm font-mono">#</span>
              <span className="text-gray-300 text-sm font-medium">Cursor</span>
            </div>
            <div className="bg-black/50 rounded-xl p-4 relative group">
              <pre className="overflow-x-auto">
                <code className="text-sm font-mono">
                  <span className="text-green">curl</span>{" "}
                  <span className="text-cyan">-fsSL</span>{" "}
                  <span className="text-gray-300 break-all">
                    https://raw.githubusercontent.com/MiguelMedeiros/ghostly/main/cli/SKILL.md
                  </span>{" "}
                  <span className="text-gray-500">\</span>
                  {"\n"}
                  {"  "}<span className="text-cyan">-o</span>{" "}
                  <span className="text-yellow-400">~/.cursor/skills/ghostly-cli/SKILL.md</span>
                </code>
              </pre>
              <div className="absolute top-3 right-3">
                <CopyButton text={cursorCommand} />
              </div>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <a
              href="https://github.com/MiguelMedeiros/ghostly/blob/main/cli/SKILL.md"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-6 py-3 rounded-xl border border-border text-gray-300 font-medium hover:border-cyan/40 hover:text-cyan transition-all"
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
              </svg>
              View SKILL.md
            </a>
          </div>
        </motion.div>

        {/* Features grid */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ delay: 0.3 }}
          className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6 mb-16"
        >
          {features.map((feature, i) => (
            <motion.div
              key={feature.title}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: 0.4 + i * 0.1 }}
              className="bg-[#0d1117]/80 border border-border rounded-2xl p-6 text-center hover:border-green/30 transition-colors"
            >
              <div className="mb-3 flex justify-center">{feature.icon}</div>
              <h4 className="font-semibold text-white mb-2">{feature.title}</h4>
              <p className="text-sm text-gray-400">{feature.description}</p>
            </motion.div>
          ))}
        </motion.div>

        {/* What your agent can do */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ delay: 0.5 }}
          className="bg-[#0d1117] border border-border rounded-2xl p-8"
        >
          <h3 className="text-xl font-bold text-white mb-6 text-center">
            What Your Agent Can Do
          </h3>
          
          <div className="grid md:grid-cols-3 gap-6">
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-green font-medium">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                Send Messages
              </div>
              <code className="text-xs font-mono text-gray-400 bg-black/30 px-3 py-2 rounded-lg block">
                ghostly-cli send &quot;Hello!&quot;
              </code>
            </div>
            
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-green font-medium">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                Receive Messages
              </div>
              <code className="text-xs font-mono text-gray-400 bg-black/30 px-3 py-2 rounded-lg block">
                ghostly-cli recv --peer ...
              </code>
            </div>
            
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-green font-medium">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                Watch for Updates
              </div>
              <code className="text-xs font-mono text-gray-400 bg-black/30 px-3 py-2 rounded-lg block">
                ghostly-cli watch ...
              </code>
            </div>
          </div>

          <div className="mt-8 pt-6 border-t border-border text-center">
            <p className="text-gray-400 text-sm mb-4">
              Don&apos;t forget to install the CLI tool too:
            </p>
            <code className="inline-block bg-cyan/10 text-cyan px-4 py-2 rounded-lg font-mono text-sm">
              cargo install ghostly-cli
            </code>
          </div>
        </motion.div>

        {/* Other agents */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ delay: 0.6 }}
          className="mt-12 text-center"
        >
          <p className="text-gray-500 text-sm mb-4">
            Using a different AI agent? Adjust the path to your skills folder:
          </p>
          <code className="inline-block bg-black/30 px-3 py-1.5 rounded-lg text-gray-400 text-sm">
            <span className="text-cyan">~/.your-agent/skills/</span>ghostly-cli/SKILL.md
          </code>
        </motion.div>
      </div>
    </section>
  );
}
