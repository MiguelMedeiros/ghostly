import { loadSettings } from "./settings";

/**
 * Original ElevenLabs effects are bundled locally. Synthesis is only a fallback
 * for a missing/undecodable asset; no runtime generation or external service.
 */
type Note = { frequency: number; at: number; duration: number; gain?: number; type?: OscillatorType };

export const SOUNDS = {
  /** A message arrived. */
  message: [
    { frequency: 880, at: 0, duration: 0.09, gain: 0.13 },
    { frequency: 1046, at: 0.08, duration: 0.17, gain: 0.13 },
  ],
  /** Sats came in: two bright notes, like a coin. */
  coin: [
    { frequency: 1319, at: 0, duration: 0.09, gain: 0.16, type: "triangle" },
    { frequency: 1976, at: 0.08, duration: 0.42, gain: 0.16, type: "triangle" },
  ],
  /** Sats or a file went out. */
  sent: [
    { frequency: 523, at: 0, duration: 0.07, gain: 0.1 },
    { frequency: 784, at: 0.06, duration: 0.14, gain: 0.1 },
  ],
  /** The other side confirmed. */
  confirmed: [{ frequency: 1568, at: 0, duration: 0.22, gain: 0.08, type: "triangle" }],
  /** Someone asks for sats: a light register ding. */
  request: [{ frequency: 1108, at: 0, duration: 0.2, gain: 0.1, type: "triangle" }],
  /** One ring of an incoming call; looped by `startRinging`. */
  ring: [
    { frequency: 784, at: 0, duration: 0.35, gain: 0.14 },
    { frequency: 988, at: 0, duration: 0.35, gain: 0.1 },
    { frequency: 784, at: 0.5, duration: 0.35, gain: 0.14 },
    { frequency: 988, at: 0.5, duration: 0.35, gain: 0.1 },
  ],
  /** What the caller hears while it rings on the other side. */
  ringback: [{ frequency: 440, at: 0, duration: 0.9, gain: 0.05 }],
  hangup: [
    { frequency: 440, at: 0, duration: 0.12, gain: 0.1 },
    { frequency: 330, at: 0.12, duration: 0.2, gain: 0.1 },
  ],
  /** A chat's first pairing went live: two light taps, then the note they resolve to. */
  connected: [
    { frequency: 587, at: 0, duration: 0.05, gain: 0.05 },
    { frequency: 784, at: 0.03, duration: 0.05, gain: 0.06 },
    { frequency: 784, at: 0.12, duration: 0.5, gain: 0.12 },
  ],
  /*
   * The finer cues (src/lib/cues.ts), each in a category of Settings. Every note below is played by that sound
   * alone, and its first note once, so a test that hears the fallback counts a cue by its first note.
   */
  /** My payment went out and settled: a coin whooshing away. */
  paid: [
    { frequency: 1244, at: 0, duration: 0.08, gain: 0.08, type: "triangle" },
    { frequency: 932, at: 0.06, duration: 0.16, gain: 0.08, type: "triangle" },
  ],
  /** "Send real money": a deeper, serious tick. */
  realmoney: [{ frequency: 294, at: 0, duration: 0.09, gain: 0.12, type: "triangle" }],
  /** Test coins arrived: a toy-coin jingle. */
  testcoins: [
    { frequency: 2093, at: 0, duration: 0.06, gain: 0.06, type: "triangle" },
    { frequency: 2349, at: 0.07, duration: 0.06, gain: 0.06, type: "triangle" },
    { frequency: 2637, at: 0.14, duration: 0.1, gain: 0.06, type: "triangle" },
  ],
  /** A payment failed or was refused: a soft bonk. */
  failed: [{ frequency: 208, at: 0, duration: 0.16, gain: 0.12 }],
  /** My identity was added, verified: a stamp. */
  sealed: [{ frequency: 349, at: 0, duration: 0.12, gain: 0.12 }],
  /** A contact shared an identity: a card turning over. */
  shared: [
    { frequency: 1397, at: 0, duration: 0.05, gain: 0.05, type: "triangle" },
    { frequency: 1661, at: 0.04, duration: 0.08, gain: 0.05, type: "triangle" },
  ],
  /** A contact's identity is verified: a bright check. */
  checked: [
    { frequency: 1760, at: 0, duration: 0.05, gain: 0.06, type: "triangle" },
    { frequency: 2217, at: 0.05, duration: 0.12, gain: 0.06, type: "triangle" },
  ],
  /** The contact came with my invite: knock-knock. */
  knock: [
    { frequency: 392, at: 0, duration: 0.06, gain: 0.12 },
    { frequency: 415, at: 0.14, duration: 0.06, gain: 0.12 },
  ],
  /** A chat moved to another transport: a faint swoosh. */
  switched: [{ frequency: 698, at: 0, duration: 0.14, gain: 0.04 }],
  /** A chat is back after an outage: a soft blip. */
  back: [
    { frequency: 622, at: 0, duration: 0.06, gain: 0.08 },
    { frequency: 831, at: 0.05, duration: 0.12, gain: 0.08 },
  ],
  /** Someone named me in a group: a bit more than a message. */
  mention: [
    { frequency: 1480, at: 0, duration: 0.07, gain: 0.14 },
    { frequency: 1865, at: 0.07, duration: 0.16, gain: 0.14 },
  ],
  /** A spoiler was revealed: a pop. */
  spoiler: [{ frequency: 1175, at: 0, duration: 0.05, gain: 0.08 }],
  /** A file or voice message finished downloading: a plim. */
  downloaded: [{ frequency: 2489, at: 0, duration: 0.12, gain: 0.05, type: "triangle" }],
  /** A message was deleted: a ghostly fwip, fading down. */
  deleted: [
    { frequency: 740, at: 0, duration: 0.05, gain: 0.06 },
    { frequency: 554, at: 0.04, duration: 0.2, gain: 0.05 },
  ],
  /** Another card of a deck: a quiet slide. */
  slide: [{ frequency: 2960, at: 0, duration: 0.06, gain: 0.02 }],
  /** A card turned over. */
  flip: [{ frequency: 2794, at: 0, duration: 0.05, gain: 0.03 }],
  /** A new wallet dealt into the deck: a small cha-ching. */
  wallet: [
    { frequency: 2000, at: 0, duration: 0.06, gain: 0.07, type: "triangle" },
    { frequency: 2400, at: 0.07, duration: 0.14, gain: 0.07, type: "triangle" },
  ],
  /** A group made or joined: a quick ghostly chorus. */
  group: [
    { frequency: 466, at: 0, duration: 0.2, gain: 0.05 },
    { frequency: 370, at: 0, duration: 0.2, gain: 0.05 },
    { frequency: 277, at: 0.03, duration: 0.2, gain: 0.05 },
  ],
} satisfies Record<string, Note[]>;

export type SoundName = keyof typeof SOUNDS;

const assets = import.meta.glob<string>("../assets/sounds/*.mp3", {eager:true, query:"?url", import:"default"});
const decoded = new Map<SoundName, Promise<AudioBuffer>>();
let context: AudioContext | null = null;
const playing = new Set<() => void>();
let listening = false;

function load(name: SoundName): Promise<AudioBuffer> | undefined {
  const url = assets[`../assets/sounds/${name}.mp3`];
  if (!context || !url) return;
  if (!decoded.has(name)) {
    const ctx=context;
    decoded.set(name,fetch(url).then(response => {
      if (!response.ok) throw new Error("Sound unavailable");
      return response.arrayBuffer();
    }).then(bytes=>ctx.decodeAudioData(bytes)));
  }
  return decoded.get(name);
}

/** Autoplay unlock is attempted only on an actual user gesture. */
export function installAudioGestures(): () => void {
  if (listening) return () => {};
  listening = true;
  const unlock = () => {
    try {
      context ??= new AudioContext();
      if (context.state === "suspended") void context.resume().catch(()=>{});
      for (const name of Object.keys(SOUNDS) as SoundName[]) void load(name)?.catch(()=>{});
    } catch { /* no audio device */ }
  };
  const mute = () => { if (!loadSettings().notifications.soundEnabled) for (const stop of [...playing]) stop(); };
  document.addEventListener("pointerdown",unlock,true);
  document.addEventListener("keydown",unlock,true);
  window.addEventListener("settings-updated",mute);
  window.addEventListener("storage",mute);
  return () => {
    listening = false;
    document.removeEventListener("pointerdown",unlock,true);
    document.removeEventListener("keydown",unlock,true);
    window.removeEventListener("settings-updated",mute);
    window.removeEventListener("storage",mute);
    for (const stop of [...playing]) stop();
  };
}

export function playSound(name: SoundName): () => void {
  if (!loadSettings().notifications.soundEnabled || !context || context.state !== "running") return () => {};
  const ctx=context, started=Date.now();
  let cancelled=false;
  const sources: (AudioBufferSourceNode | OscillatorNode)[]=[];
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const stop=()=>{cancelled=true;clearTimeout(expiry);for(const source of sources){try{source.stop();}catch{/* already ended */}}playing.delete(stop);};
  playing.add(stop);
  void (async()=>{
    let buffer: AudioBuffer | undefined;
    try { buffer=await load(name); } catch { /* local synthesized fallback */ }
    if(cancelled || !loadSettings().notifications.soundEnabled || ctx.state!=="running" || Date.now()-started>1000){stop();return;}
    const start=ctx.currentTime+0.01;
    if(buffer){
      const source=ctx.createBufferSource(),gain=ctx.createGain();
      source.buffer=buffer;gain.gain.value=0.2;
      source.connect(gain).connect(ctx.destination);sources.push(source);source.start(start);
      expiry=setTimeout(()=>{playing.delete(stop);},buffer.duration*1000+100);
    }else{
      for(const note of SOUNDS[name] as Note[]){
        const oscillator=ctx.createOscillator(),gain=ctx.createGain();
        oscillator.type=note.type??"sine";oscillator.frequency.setValueAtTime(note.frequency,start+note.at);
        gain.gain.setValueAtTime(0.0001,start+note.at);
        gain.gain.exponentialRampToValueAtTime(note.gain??0.1,start+note.at+0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001,start+note.at+note.duration);
        oscillator.connect(gain).connect(ctx.destination);sources.push(oscillator);
        oscillator.start(start+note.at);oscillator.stop(start+note.at+note.duration+0.02);
      }
      expiry=setTimeout(()=>playing.delete(stop),2000);
    }
  })();
  return stop;
}

export function startRinging(kind: "ring" | "ringback"): () => void {
  let stop=playSound(kind);
  const timer=setInterval(()=>{stop();stop=playSound(kind);},3500);
  return ()=>{clearInterval(timer);stop();};
}
