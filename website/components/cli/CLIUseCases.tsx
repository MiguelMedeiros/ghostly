"use client";

import { motion } from "motion/react";

function BotIcon() {
  return (
    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
    </svg>
  );
}

function BellIcon() {
  return (
    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
    </svg>
  );
}

function ServerIcon() {
  return (
    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-16.5-3a3 3 0 013-3h13.5a3 3 0 013 3m-19.5 0a4.5 4.5 0 01.9-2.7L5.737 5.1a3.375 3.375 0 012.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 01.9 2.7m0 0a3 3 0 01-3 3m0 3h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008zm-3 6h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008z" />
    </svg>
  );
}

function UsersIcon() {
  return (
    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" />
    </svg>
  );
}

const useCases = [
  {
    icon: <BotIcon />,
    title: "AI Assistant Communication",
    description: "Let your AI agent send you private updates, summaries, or ask for clarification — all encrypted and ephemeral.",
    example: "OpenClaw sends you a private summary of research findings",
    color: "cyan",
  },
  {
    icon: <BellIcon />,
    title: "Encrypted Alerts & Notifications",
    description: "Server alerts, deployment notifications, security warnings — without exposing sensitive info to third-party services.",
    example: "CI/CD pipeline sends encrypted build status to your device",
    color: "green",
  },
  {
    icon: <ShieldIcon />,
    title: "Secure OTP & Auth Codes",
    description: "Send one-time passwords or verification codes through a channel that leaves no trace.",
    example: "Bot sends 2FA backup codes that disappear after reading",
    color: "cyan",
  },
  {
    icon: <ServerIcon />,
    title: "Private DevOps Commands",
    description: "Issue sensitive commands to your infrastructure bots without logging them anywhere.",
    example: "Send database credentials rotation commands privately",
    color: "green",
  },
  {
    icon: <UsersIcon />,
    title: "Anonymous Feedback Collection",
    description: "Collect user feedback or reports through truly anonymous, untraceable channels.",
    example: "Whistleblower bot receives anonymous tips with no metadata",
    color: "cyan",
  },
  {
    icon: <LinkIcon />,
    title: "Cross-Platform Bridge",
    description: "Bridge messages between platforms while maintaining privacy — no central server sees the content.",
    example: "Forward private messages between Slack and Matrix anonymously",
    color: "green",
  },
];

export function CLIUseCases() {
  return (
    <section id="use-cases" className="py-24 px-6 bg-[#080c12]">
      <div className="max-w-6xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-center mb-16"
        >
          <h2 className="font-mono text-4xl font-bold mb-4">
            <span className="text-gradient">Use Cases</span>
          </h2>
          <p className="text-gray-400 text-lg max-w-2xl mx-auto">
            What can your bot do with encrypted ephemeral messaging?
          </p>
        </motion.div>

        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
          {useCases.map((useCase, i) => (
            <motion.div
              key={useCase.title}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.1 }}
              className={`bg-[#0d1117] border rounded-2xl p-6 hover:border-${useCase.color}/40 transition-all group ${
                useCase.color === "cyan" ? "border-cyan/20" : "border-green/20"
              }`}
            >
              <div className={`w-12 h-12 rounded-xl flex items-center justify-center mb-4 ${
                useCase.color === "cyan" 
                  ? "bg-cyan/10 text-cyan" 
                  : "bg-green/10 text-green"
              }`}>
                {useCase.icon}
              </div>
              
              <h3 className="text-lg font-semibold text-white mb-2 group-hover:text-cyan transition-colors">
                {useCase.title}
              </h3>
              
              <p className="text-gray-400 text-sm mb-4">
                {useCase.description}
              </p>
              
              <div className={`text-xs px-3 py-2 rounded-lg ${
                useCase.color === "cyan" 
                  ? "bg-cyan/5 text-cyan/80 border border-cyan/10" 
                  : "bg-green/5 text-green/80 border border-green/10"
              }`}>
                <span className="opacity-60">Example:</span> {useCase.example}
              </div>
            </motion.div>
          ))}
        </div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ delay: 0.6 }}
          className="mt-16 text-center"
        >
          <p className="text-gray-500 mb-6">
            All messages are end-to-end encrypted and vanish from the network.
            <br />
            No logs. No traces. No middleman.
          </p>
          <a
            href="#examples"
            className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-cyan/10 text-cyan font-medium border border-cyan/20 hover:bg-cyan/20 transition-all"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
            </svg>
            See Code Examples
          </a>
        </motion.div>
      </div>
    </section>
  );
}
