import { loadSettings } from "./settings";

/**
 * Original ElevenLabs effects are bundled locally. Synthesis is only a fallback
 * for a missing/undecodable asset; no runtime generation or external service.
 */
type Note = { frequency: number; at: number; duration: number; gain?: number; type?: OscillatorType };

const SOUNDS = {
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
  /** Someone asks for sats. */
  request: [
    { frequency: 659, at: 0, duration: 0.1, gain: 0.12 },
    { frequency: 659, at: 0.16, duration: 0.1, gain: 0.12 },
  ],
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
