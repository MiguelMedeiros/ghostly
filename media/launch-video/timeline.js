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

/**
 * Every moment the picture moves on. One idea at a time, held long enough to read: about one change per bar, and
 * never two new words in the same beat.
 */
export const M = {
  // 1-2: the ghost, then the name
  logo: at(1), blink: at(1, 3), word: at(2), v1: at(2, 3),
  // 3-4: an invite, a knock, connected
  invite: at(3), knock: at(4), paired: at(4, 3),
  // 5-7: one chat, any path; a silent beat before the drop
  oneChat: at(5), anyPath: at(5, 3), paths: [at(6), at(6, 3), at(7), at(7, 3)], gap: at(7, 4),
  // 8-12: the drop, the wallets
  drop: at(8), wallets: at(8, 3), tabs: at(10), testnet: at(10, 3), pay: at(11), real: at(11, 3), test: at(12), mixed: at(12, 3),
  // 13-16: identities
  ids: at(13), flips: [at(13, 3), at(14), at(14, 3)], photo: at(15), verified: at(15, 3), share: at(16), shared: at(16, 3),
  // 17-20: the chat, one message a bar
  chat: at(17), messages: [at(17, 3), at(18, 3), at(19, 3), at(20, 1)], chatOut: at(20, 4),
  // 21-22: private by design (the music's breakdown)
  seed: at(21), guard: at(21, 3), safe: at(22), safeOut: at(22, 4),
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
  { at: M.invite, sound: "spoiler", db: 8 },
  { at: M.knock, sound: "knock", db: 8 },
  { at: M.paired, sound: "checked", db: 6 },
  { at: M.oneChat, sound: "message", db: 5 },
  ...M.paths.map((at) => ({ at, sound: "switched", db: 14 })),
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
  ...M.messages.map((at, i) => ({ at, sound: ["sent", "message", "request", "mention"][i], db: [6, 5, 6, 5][i] })),
  { at: M.chatOut, sound: "deleted", db: 8 },
  { at: M.seed, sound: "checked", db: 4 },
  { at: M.guard, sound: "failed", db: 9 },
  { at: M.safe, sound: "back", db: 7 },
  ...M.words.map((at) => ({ at, sound: "checked", db: 3 })),
  { at: M.end, sound: "connected", db: 7 },
];
