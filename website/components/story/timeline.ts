// Shared poses let each section continue the same story on its own scroll clock.
export const chapters = [
  {
    id: "beginning",
    label: "A connection worth finding",
    short: "Hello",
    title: "Even ghosts need",
    accent: "a connection.",
    description:
      "Meet Boo. A little ghost with someone to find — and a whole world to share.",
    note: "Ghostly is an open protocol for private, peer-to-peer connections. No account required.",
  },
  {
    id: "how-it-works",
    label: "01 / The invitation",
    short: "Invite",
    title: "One private invite.",
    accent: "Two little ghosts.",
    description:
      "Boo shares an invitation with Casper. It gives them the identities and shared secret they need to find each other.",
    note: "No email. No phone number. Every connection has its own identities. Keep the invitation private.",
  },
  {
    id: "discovery",
    label: "02 / The discovery",
    short: "Publish",
    title: "A big network.",
    accent: "Two tiny signals.",
    description:
      "Each ghost publishes a signed record under its own public key. The DHT distributes those records across the network.",
    note: "Pkarr on the BitTorrent DHT. The records carry encrypted discovery information and short messages.",
  },
  {
    id: "keys",
    label: "03 / The shared secret",
    short: "Unlock",
    title: "Anyone can see the record.",
    accent: "Only they can read the message.",
    description:
      "The public key locates Boo’s record. The shared secret unlocks its private contents for Casper.",
    note: "Records are publicly retrievable. Encryption protects their private contents; it doesn’t hide their existence.",
  },
  {
    id: "connection",
    label: "04 / The connection",
    short: "Connect",
    title: "There you are.",
    accent: "Let’s talk.",
    description:
      "Discovery brings them together. An encrypted WebRTC connection opens between their devices.",
    note: "Pkarr relays and STUN help them meet. Optional TURN can relay encrypted traffic when needed.",
  },
  {
    id: "features",
    label: "05 / Make yourself heard",
    short: "Talk",
    title: "A message. A voice.",
    accent: "A familiar face.",
    description:
      "Say hello, start a call, turn on the camera or share your screen. All inside the same private connection.",
    note: "Encrypted chat, GIFs and delivery indicators. Voice, video and screen sharing on supported computers.",
  },
  {
    id: "send",
    label: "06 / Pass something along",
    short: "Share",
    title: "Send a little something.",
    accent: "Or a little thank-you.",
    description:
      "A photo. A project. A few sats. Files and value travel right inside the conversation.",
    note: "Files up to 100 MiB. Cashu ecash and Lightning payments. Ecash mints hold the funds.",
  },
  {
    id: "local-apps",
    label: "07 / Open a little door",
    short: "Apps",
    title: "Your localhost.",
    accent: "Their next tab.",
    description:
      "Boo shares a local app. Casper opens it through Ghostly, while it keeps running on Boo’s computer.",
    note: "Desktop or extension on both ends. Enabled apps are available to all linked contacts while you’re online.",
  },
  {
    id: "automation",
    label: "08 / Let your code join in",
    short: "Build",
    title: "Even your code",
    accent: "can say boo.",
    description:
      "Give your scripts, bots and AI agents a private line. Send encrypted text and listen for a reply.",
    note: "The CLI supports text messaging, JSON output and an NDJSON stream. Your code supplies the automation.",
  },
  {
    id: "goodnight",
    label: "09 / Until next time",
    short: "Goodnight",
    title: "The signal fades.",
    accent: "The connection is yours.",
    description:
      "Boo goes offline. The live channel closes. Without fresh publications, the network records gradually expire.",
    note: "Expiry isn’t instant erasure. Your identities, history, files and wallet stay on your device until you delete them.",
  },
] as const;

export const clamp = (value: number) => Math.min(1, Math.max(0, value));
export function beat(t: number, start: number, end: number) {
  const x = clamp((t - start) / (end - start));
  return x * x * (3 - 2 * x);
}
export const mix = (a: number, b: number, amount: number) =>
  a + (b - a) * amount;
export function appear(t: number, start: number, end: number, fade = 0.14) {
  return beat(t, start, start + fade) * (1 - beat(t, end - fade, end));
}

export function sampleStory(t: number, compact = false) {
  const split = beat(t, 0.88, 1.32);
  const network = beat(t, 1.96, 2.22) * (1 - beat(t, 3.85, 4.22));
  const goodbye = beat(t, 9.08, 9.34);
  const features = beat(t, 4.9, 5.15);
  const x = compact ? 235 : 185;
  const y = compact ? 405 : 245;
  return {
    boo: {
      x: mix(500, x, split),
      y: mix(compact ? 275 : 240, y, split),
      scale: mix(compact ? 2.15 : 1.6, compact ? 1.17 : 1, split),
      opacity: 1 - goodbye * 0.65,
    },
    casper: {
      x: 1000 - x,
      y,
      scale: compact ? 1.17 : 1,
      opacity: beat(t, 1.1, 1.46),
    },
    network: Math.max(network, appear(t, 9.18, 9.94, 0.16) * 0.5),
    connection: beat(t, 4.12, 4.62) * (1 - beat(t, 9.02, 9.28)),
    connectionY: mix(y, compact ? 405 : 295, features),
    invite: appear(t, 1.14, 1.96),
    inviteTravel: beat(t, 1.32, 1.69),
    decrypt: beat(t, 3.43, 3.7),
    goodbye,
  };
}
