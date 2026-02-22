"use client";

import { motion } from "motion/react";
import { useState } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";

const customTheme = {
  ...oneDark,
  'pre[class*="language-"]': {
    ...oneDark['pre[class*="language-"]'],
    background: "transparent",
    margin: 0,
    padding: "1rem",
    fontSize: "0.75rem",
  },
  'code[class*="language-"]': {
    ...oneDark['code[class*="language-"]'],
    background: "transparent",
    fontSize: "0.75rem",
  },
};

const icons = {
  bot: (
    <svg className="w-7 h-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <rect x="3" y="8" width="18" height="12" rx="2" />
      <circle cx="9" cy="14" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="15" cy="14" r="1.5" fill="currentColor" stroke="none" />
      <path d="M12 2v4" />
      <circle cx="12" cy="2" r="1" fill="currentColor" stroke="none" />
    </svg>
  ),
  claw: (
    <svg className="w-7 h-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="M12 21c-4.97 0-9-2.686-9-6V9c0-3.314 4.03-6 9-6s9 2.686 9 6v6c0 3.314-4.03 6-9 6z" />
      <ellipse cx="12" cy="9" rx="9" ry="6" />
      <path d="M6 9c0 1.5 2.686 3 6 3s6-1.5 6-3" />
    </svg>
  ),
  bell: (
    <svg className="w-7 h-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 01-3.46 0" />
    </svg>
  ),
  bridge: (
    <svg className="w-7 h-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="M4 18v-4a8 8 0 0116 0v4" />
      <path d="M2 18h20" />
      <path d="M12 6v8" />
      <path d="M8 10v8" />
      <path d="M16 10v8" />
    </svg>
  ),
};

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className="absolute top-3 right-3 p-2 rounded-lg bg-white/5 hover:bg-white/10 transition-colors z-10"
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

const examples = [
  {
    title: "AI Chat Bot",
    description: "Build a bot that responds to messages using AI",
    icon: "bot" as keyof typeof icons,
    language: "bash",
    code: `#!/bin/bash
# Simple AI bot using ghostly-cli

SEED="your-bot-seed"
PEER="peer-pubkey"  
KEY="shared-key"

# Watch for messages and respond
ghostly-cli watch --seed "$SEED" --peer "$PEER" --key "$KEY" | while read -r msg; do
  text=$(echo "$msg" | jq -r '.text')
  
  # Call your AI API
  response=$(curl -s "https://api.openai.com/v1/chat/completions" \\
    -H "Authorization: Bearer $OPENAI_KEY" \\
    -d '{"model":"gpt-4","messages":[{"role":"user","content":"'"$text"'"}]}' \\
    | jq -r '.choices[0].message.content')
  
  # Send response
  ghostly-cli send --seed "$SEED" --peer "$PEER" --key "$KEY" "$response"
done`,
  },
  {
    title: "OpenClaw Integration",
    description: "Install as an OpenClaw skill for AI agents",
    icon: "claw" as keyof typeof icons,
    language: "bash",
    code: `# Install ghostly-cli skill for OpenClaw
mkdir -p ~/.openclaw/workspace/skills/ghostly-cli
curl -fsSL https://ghostly.chat/SKILL.md \\
  -o ~/.openclaw/workspace/skills/ghostly-cli/SKILL.md

# The skill enables OpenClaw to:
# - Send encrypted messages to peers
# - Watch for incoming messages
# - Build chat bots and notification services

# Example: Ask OpenClaw to send a message
# "Send a Ghost message to pk:abc123 saying hello"

# Example: Ask OpenClaw to set up a bot
# "Watch for Ghost messages and respond with AI"`,
  },
  {
    title: "Notification Service",
    description: "Send encrypted alerts to your devices",
    icon: "bell" as keyof typeof icons,
    language: "bash",
    code: `#!/bin/bash
# Send encrypted notifications from your server

notify() {
  local message="$1"
  local timestamp=$(date +%s)
  
  ghostly-cli send \\
    --seed "$BOT_SEED" \\
    --peer "$MY_DEVICE_PUBKEY" \\
    --key "$SHARED_KEY" \\
    --nick "Server Alert" \\
    "[$(date)] $message"
}

# Usage examples
notify "Deployment completed successfully"
notify "Warning: CPU usage above 90%"
notify "New user signup: user@example.com"`,
  },
  {
    title: "Two-Way Bridge",
    description: "Bridge Ghost messages to other platforms",
    icon: "bridge" as keyof typeof icons,
    language: "bash",
    code: `#!/bin/bash
# Bridge Ghost messages to Slack/Discord/etc

SEED="bridge-seed"
PEER="channel-pubkey"
KEY="channel-key"
SLACK_WEBHOOK="https://hooks.slack.com/..."

ghostly-cli watch --seed "$SEED" --peer "$PEER" --key "$KEY" | while read -r msg; do
  text=$(echo "$msg" | jq -r '.text')
  nick=$(echo "$msg" | jq -r '.nick // "Anonymous"')
  
  # Forward to Slack
  curl -X POST "$SLACK_WEBHOOK" \\
    -H 'Content-type: application/json' \\
    -d '{"text":"[Ghost] '"$nick"': '"$text"'"}'
done`,
  },
];

export function CLIExamples() {
  return (
    <section id="examples" className="py-24 px-6 bg-[#080c12]">
      <div className="max-w-6xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-center mb-16"
        >
          <h2 className="font-mono text-4xl font-bold mb-4">
            <span className="text-gradient">Examples</span>
          </h2>
          <p className="text-gray-400 text-lg max-w-2xl mx-auto">
            Ready-to-use scripts for common bot scenarios
          </p>
        </motion.div>

        <div className="grid md:grid-cols-2 gap-8">
          {examples.map((example, i) => (
            <motion.div
              key={example.title}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.1 }}
              className="bg-[#0d1117] border border-border rounded-2xl overflow-hidden"
            >
              <div className="p-6 border-b border-border">
                <div className="flex items-center gap-3 mb-2">
                  <div className="text-cyan">{icons[example.icon]}</div>
                  <h3 className="text-xl font-semibold text-white">{example.title}</h3>
                </div>
                <p className="text-gray-400">{example.description}</p>
              </div>
              <div className="relative overflow-x-auto max-h-80">
                <SyntaxHighlighter
                  language={example.language}
                  style={customTheme}
                  customStyle={{
                    background: "transparent",
                    margin: 0,
                    padding: "1rem",
                  }}
                  codeTagProps={{
                    style: {
                      fontSize: "0.75rem",
                      fontFamily: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Monaco, Consolas, monospace",
                    },
                  }}
                >
                  {example.code}
                </SyntaxHighlighter>
                <CopyButton text={example.code} />
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
