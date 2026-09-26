// The film's one clock, shared by the picture (film/) and the sound (mix.mjs): the music's grid, the moments on
// it, and the sound each moment makes. A moment is written as bar and beat (both from 1; a beat may be a
// fraction), so a cut, a motion and its sound land on the same beat by construction.
export const BPM = 128;
export const BEAT = 60 / BPM;
export const BAR = 4 * BEAT;
/** The seconds of bar `bar`, beat `beat` (bar 1 beat 1 is 0 s). */
export const at = (bar, beat = 1) => (bar - 1) * BAR + (beat - 1) * BEAT;
/** 24 bars at 128 BPM. */
export const DURATION = 45;

/** Every moment the picture moves on. */
export const M = {
  // 1-2: the ghost, then the name
  logo: at(1), blink: at(1, 3), word: at(2), v1: at(2, 3),
  // 3-4: an invite becomes a QR, a contact knocks, paired
  code: at(3), qr: at(3, 3), knock: at(4), paired: at(4, 3),
  // 5-7: one chat, any path; the build
  oneChat: at(5), anyPath: at(5, 3), webrtc: at(6), iroh: at(6, 2), hyperdht: at(6, 3), dht: at(6, 4),
  build: at(7), buildHits: [at(7), at(7, 2), at(7, 3)], gap: at(7, 4),
  // 8-11: the drop, the wallets
  drop: at(8), wallets: at(8, 3), tabs: at(9), testnet: at(9, 3), pay: at(10), real: at(10, 3), test: at(11), mixed: at(11, 3),
  // 12-15: identities
  ids: at(12), flips: [at(12, 3), at(13), at(13, 3)], photo: at(14), verified: at(14, 3), share: at(15), shared: at(15, 3),
  // 16-19: the chat
  chat: at(16), markdown: at(16, 3), invite: at(17), money: at(17, 3), mention: at(18), codeBlock: at(18, 3), smart: at(19), chatOut: at(19, 4),
  // 20-22: private by design (the music's breakdown)
  servers: at(20), keys: at(20, 3), seed: at(21), guard: at(21, 3), safe: at(22), safeOut: at(22, 3),
  // 23-24: the outro and the last hit
  words: [at(23), at(23, 2), at(23, 3)], gap2: at(23, 4), end: at(24),
};

/**
 * The app's own cues (src/assets/sounds) on the moments, as the mix places them: each file starts so its attack
 * lands on the moment. `db` is its gain over the file's own level (the app's cues are quiet by design).
 */
export const CUES = [
  { at: M.logo, sound: "connected", db: 7 },
  { at: M.v1, sound: "sealed", db: 7 },
  { at: M.code, sound: "sent", db: 6 },
  { at: M.qr, sound: "spoiler", db: 8 },
  { at: M.knock, sound: "knock", db: 8 },
  { at: M.paired, sound: "checked", db: 6 },
  { at: M.oneChat, sound: "message", db: 5 },
  { at: M.webrtc, sound: "switched", db: 14 },
  { at: M.iroh, sound: "switched", db: 14 },
  { at: M.hyperdht, sound: "switched", db: 14 },
  { at: M.dht, sound: "switched", db: 14 },
  { at: M.drop, sound: "wallet", db: 9 },
  { at: M.tabs, sound: "realmoney", db: 6 },
  { at: M.testnet, sound: "flip", db: 12 },
  { at: M.pay, sound: "paid", db: 8 },
  { at: M.real, sound: "realmoney", db: 6 },
  { at: M.test, sound: "testcoins", db: 7 },
  { at: M.mixed, sound: "sealed", db: 7 },
  { at: M.ids, sound: "slide", db: 16 },
  ...M.flips.map((at) => ({ at, sound: "flip", db: 12 })),
  { at: M.photo, sound: "downloaded", db: 8 },
  { at: M.verified, sound: "sealed", db: 8 },
  { at: M.shared, sound: "shared", db: 8 },
  { at: M.chat, sound: "message", db: 5 },
  { at: M.markdown, sound: "spoiler", db: 8 },
  { at: M.invite, sound: "sent", db: 6 },
  { at: M.money, sound: "request", db: 6 },
  { at: M.mention, sound: "mention", db: 5 },
  { at: M.codeBlock, sound: "message", db: 5 },
  { at: M.chatOut, sound: "deleted", db: 8 },
  { at: M.servers, sound: "deleted", db: 8 },
  { at: M.keys, sound: "checked", db: 6 },
  { at: M.guard, sound: "failed", db: 9 },
  { at: M.safe, sound: "back", db: 7 },
  ...M.words.map((at) => ({ at, sound: "checked", db: 3 })),
  { at: M.end, sound: "connected", db: 7 },
];
