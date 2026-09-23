import type { IconName } from "../components/icons";

export const features = [
  {
    id: "chat",
    label: "Chat",
    icon: "chat",
    kicker: "For the conversations that are yours",
    title: "Say hello. Skip the sign-up.",
    description:
      "Create a private connection with an invite. Talk with your contact without handing over a phone number or email address.",
    details: [
      "End-to-end encrypted messages",
      "GIFs, emoji and delivery indicators",
      "A separate identity for every connection",
    ],
    note: "Your chat history is saved on your device. You decide when to delete it.",
    href: "https://app.ghostly.tools",
    cta: "Start a conversation",
  },
  {
    id: "calls",
    label: "Calls & screen",
    icon: "video",
    kicker: "When text isn’t quite enough",
    title: "From a quick hello to “let me show you.”",
    description:
      "Start with your voice. Turn on your camera or share your screen in the same call, and keep the conversation going alongside it.",
    details: [
      "Voice and video over encrypted WebRTC",
      "Switch between camera and screen",
      "A movable call window, with chat still in reach",
    ],
    note: "Screen sharing needs a supported desktop browser or app. Both contacts must be online.",
    href: "https://app.ghostly.tools",
    cta: "Try a call",
  },
  {
    id: "files",
    label: "Files",
    icon: "file",
    kicker: "For the thing you want to send",
    title: "From your device. To theirs.",
    description:
      "Send a photo, a document or that project archive straight through your connection. No separate upload link to manage.",
    details: [
      "Up to 100 MiB per file",
      "Image previews inside the conversation",
      "Encrypted transfers with live progress",
    ],
    note: "Both contacts must be online. Received files are saved locally until the chat is deleted.",
    href: "https://app.ghostly.tools",
    cta: "Send your first file",
  },
  {
    id: "sats",
    label: "Sats",
    icon: "bolt",
    kicker: "A thank-you can travel with the chat",
    title: "Send a message. Send a little value.",
    description:
      "Send or request sats — small units of bitcoin — in your conversation. The built-in Cashu wallet connects to Lightning for payments in and out.",
    details: [
      "Pay invoices and redeem pasted ecash tokens",
      "Choose mints and see payment history and fees",
      "Reclaim chat payments that were never confirmed",
    ],
    note: "Ecash mints hold the funds. There is no recovery seed; backup tokens are available in wallet settings.",
    href: "/docs#payments",
    cta: "How payments work",
  },
  {
    id: "apps",
    label: "Local apps",
    icon: "globe",
    kicker: "Your computer has something worth sharing",
    title: "“It’s on my localhost.” Now they can open it.",
    description:
      "Show a prototype, a photo gallery or a local tool. Your contacts use the app running on your computer, through Ghostly, while you’re online.",
    details: [
      "Pick the local app you want to share",
      "Contacts open it directly from your conversation",
      "Stop sharing and access through Ghostly ends",
    ],
    note: "Requires desktop or the extension on both ends. Shared apps are available to all your linked contacts. WebSockets and streaming responses aren’t supported yet.",
    href: "#download",
    cta: "Get Ghostly for local apps",
  },
  {
    id: "automate",
    label: "Bots & CLI",
    icon: "terminal",
    kicker: "For the things you’re building next",
    title: "Give your scripts a private line.",
    description:
      "Connect bots, notifications and AI agents to a Ghostly conversation. Send encrypted text from the terminal and process incoming messages in your own tools.",
    details: [
      "Create identities and invitations from the CLI",
      "Send, receive and watch text messages",
      "JSON output and an NDJSON message stream",
    ],
    note: "The CLI handles text messaging. Calls, files, the wallet and shared apps live in the graphical clients.",
    href: "/cli",
    cta: "Explore the CLI",
  },
] as const satisfies readonly {
  id: string;
  label: string;
  icon: IconName;
  kicker: string;
  title: string;
  description: string;
  details: readonly string[];
  note: string;
  href: string;
  cta: string;
}[];

export type FeatureId = (typeof features)[number]["id"];
