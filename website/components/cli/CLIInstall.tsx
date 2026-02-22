"use client";

import { motion } from "motion/react";
import { useState } from "react";

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
      className="absolute top-3 right-3 p-2 rounded-lg bg-white/5 hover:bg-white/10 transition-colors"
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

function CodeBlock({ children, copyText }: { children: React.ReactNode; copyText: string }) {
  return (
    <div className="relative group">
      <pre className="bg-[#0d1117] border border-border rounded-xl p-4 overflow-x-auto">
        <code className="text-sm font-mono text-gray-300">{children}</code>
      </pre>
      <CopyButton text={copyText} />
    </div>
  );
}

export function CLIInstall() {
  return (
    <section id="install" className="py-24 px-6">
      <div className="max-w-4xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-center mb-16"
        >
          <h2 className="font-mono text-4xl font-bold mb-4">
            <span className="text-gradient">Installation</span>
          </h2>
          <p className="text-gray-400 text-lg">
            Get started in seconds
          </p>
        </motion.div>

        <div className="space-y-8">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: 0.1 }}
          >
            <h3 className="text-xl font-semibold text-cyan mb-4 flex items-center gap-2">
              <span className="w-8 h-8 rounded-full bg-cyan/20 flex items-center justify-center text-sm">1</span>
              Install with Cargo
            </h3>
            <CodeBlock copyText="cargo install ghostly-cli">
              <span className="text-gray-500">$</span> cargo install ghostly-cli
            </CodeBlock>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: 0.2 }}
          >
            <h3 className="text-xl font-semibold text-cyan mb-4 flex items-center gap-2">
              <span className="w-8 h-8 rounded-full bg-cyan/20 flex items-center justify-center text-sm">2</span>
              Create Your Identity
            </h3>
            <CodeBlock copyText="ghostly-cli identity new > ~/.ghostly-identity.json">
              <span className="text-gray-500">$</span> ghostly-cli identity new &gt; ~/.ghostly-identity.json{"\n"}
              <span className="text-green">{`{"seed":"...","pubkey":"pk:...","shared_key":"..."}`}</span>
            </CodeBlock>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: 0.3 }}
          >
            <h3 className="text-xl font-semibold text-cyan mb-4 flex items-center gap-2">
              <span className="w-8 h-8 rounded-full bg-cyan/20 flex items-center justify-center text-sm">3</span>
              Generate an Invite
            </h3>
            <CodeBlock copyText='ghostly-cli invite new --seed "$SEED"'>
              <span className="text-gray-500">$</span> ghostly-cli invite new --seed &quot;$SEED&quot;{"\n"}
              <span className="text-green">{`{"invite_url":"ghost://pk:abc...#key...","pubkey":"pk:abc..."}`}</span>
            </CodeBlock>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: 0.4 }}
          >
            <h3 className="text-xl font-semibold text-cyan mb-4 flex items-center gap-2">
              <span className="w-8 h-8 rounded-full bg-cyan/20 flex items-center justify-center text-sm">4</span>
              Start Chatting
            </h3>
            <CodeBlock copyText='ghostly-cli send --seed "$SEED" --peer "$PEER" --key "$KEY" "Hello!"'>
              <span className="text-gray-500">$</span> ghostly-cli send --seed &quot;$SEED&quot; --peer &quot;$PEER&quot; --key &quot;$KEY&quot; &quot;Hello!&quot;{"\n"}
              <span className="text-green">{`{"ok":true,"timestamp":1708123456789,"messages_kept":1}`}</span>
            </CodeBlock>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
