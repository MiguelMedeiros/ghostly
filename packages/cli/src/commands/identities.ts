import { type Command, here } from "./shared";

/** Identity proofs: one entry per command, in alphabetical order (test/commands.test.ts checks). */
export const commands: Record<string, Command> = {
  "identity cancel": { method: "identity.cancel", usage: "identity cancel <draft>", summary: "Drop a proof not finished", args: ["draft"], params: (_, a) => ({ draft: a.draft }) },
  "identity complete": {
    method: "identity.complete", usage: "identity complete <draft> [--evidence-file f | --stdin]", summary: "Finish a proof: what the tool printed, or nothing for a published record",
    args: ["draft"], options: { "evidence-file": { type: "string", description: "The tool's output, from this file" }, stdin: { type: "boolean", description: "The tool's output, from stdin" } },
    params: ({ options }, a) => ({ draft: a.draft, evidenceFile: here(options["evidence-file"]), stdin: options.stdin === true }),
  },
  "identity contact": { method: "identity.contact", usage: "identity contact <chat>", summary: "What a contact shared, as this device checked it", args: ["chat"], params: (_, a) => ({ chat: a.chat }) },
  "identity list": { method: "identity.list", usage: "identity list", summary: "This profile's identity proofs" },
  "identity providers": { method: "identity.providers", usage: "identity providers", summary: "Kinds of identity proof, and which signers work here" },
  "identity recheck": { method: "identity.recheck", usage: "identity recheck <chat> <id>", summary: "Check a contact's proof again", args: ["chat", "id"], params: (_, a) => ({ chat: a.chat, id: a.id }) },
  "identity remove": { method: "identity.remove", usage: "identity remove <id>", summary: "Remove a proof: withdrawn from every chat, revoked", args: ["id"], params: (_, a) => ({ id: a.id }) },
  "identity share": { method: "identity.share", usage: "identity share <chat> <id>", summary: "Show a proof to a contact", args: ["chat", "id"], params: (_, a) => ({ chat: a.chat, id: a.id }) },
  "identity withdraw": { method: "identity.withdraw", usage: "identity withdraw <chat> <id>", summary: "Withdraw a proof from a contact", args: ["chat", "id"], params: (_, a) => ({ chat: a.chat, id: a.id }) },
};
