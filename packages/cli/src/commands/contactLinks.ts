import type { Command } from "./shared";

/** The profile's contact link and the requests it takes (WISP 8xx): one entry per command, in alphabetical order. */
export const commands: Record<string, Command> = {
  "contact-link create": { method: "contact-link.create", usage: "contact-link create", summary: "A contact link for this profile, to post anywhere: it names nobody (the link before stops)" },
  "contact-link off": { method: "contact-link.off", usage: "contact-link off", summary: "Turn the contact link off: whoever opens it is told so" },
  "contact-link show": { method: "contact-link.show", usage: "contact-link show", summary: "The contact link, how many requests wait, and how many tried while it was busy" },
  "requests accept": { method: "requests.accept", usage: "requests accept <request>", summary: "Accept a request: its chat starts, with the requester's name and first message", args: ["request"], params: (_, a) => ({ request: a.request }) },
  "requests decline": { method: "requests.decline", usage: "requests decline <request>", summary: "Decline a request: nothing is said back, and that requester cannot ask again through this link", args: ["request"], params: (_, a) => ({ request: a.request }) },
  "requests list": { method: "requests.list", usage: "requests list", summary: "Requests the contact link took, newest first (looks for new ones first)" },
};
