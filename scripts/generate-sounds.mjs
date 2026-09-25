import {mkdir,writeFile,readFile} from "node:fs/promises";
import {fileURLToPath,pathToFileURL} from "node:url";
import {resolve} from "node:path";
import {parseArgs} from "node:util";
/*
 * Development only: makes the app's sound effects with ElevenLabs. Nothing runs this at build or test time.
 *   node scripts/generate-sounds.mjs                 every effect below (each one is billed)
 *   node scripts/generate-sounds.mjs connected       only the named effects; the other files are left as they are
 *   ... connected --out <dir> [--prompt "…"] [--duration 0.8]
 *                                                    a take to audition: the mp3 and a provenance.json that would
 *                                                    go with it land in <dir>; adopt it by copying both into
 *                                                    src/assets/sounds and its prompt into the list below
 */
const {values:options,positionals:names}=parseArgs({allowPositionals:true,options:{out:{type:"string"},prompt:{type:"string"},duration:{type:"string"}}});
const family="Original minimal interface sound for a calm private messaging app. Soft rounded glass and airy felt mallet texture, warm, clean, understated, no harsh frequencies, no hiss, no voice, no music, no recognizable brand melody. Low-intensity intimate sound, clean silence around the effect.";
const effects=[
 ["message",0.5,"One soft rising two-note droplet, incoming message. Fast gentle attack and very short decay."],
 ["sent",0.5,"One soft tiny upward pluck and airy flick, message sent, shorter and quieter than an incoming alert."],
 ["coin",0.7,"Two warm rounded glass notes, quietly positive, wallet funds received and confirmed. No metallic cash register."],
 ["confirmed",0.6,"One warm low pluck resolving into a softer high note, wallet payment completed. Calm confirmation."],
 ["request",0.5,"Two small muted taps, gentle request, unobtrusive."],
 ["ring",2.5,"A gentle three-note invitation to an incoming call, followed by generous silence, suitable for repeating. Soft marimba-like glass, not alarming."],
 ["ringback",2.5,"One low soft resonant pulse followed by generous silence, waiting for a call to be answered."],
 ["hangup",0.5,"Two very soft descending rounded plucks, a call has ended, calm and brief."],
 ["connected",0.9,"Two gentle glass taps, one from each side, then a soft upward resolution. Peaceful, reassuring, connected. Short clean fade."]
];
const unknown=names.filter(name=>!effects.some(([known])=>known===name));
if(unknown.length) throw new Error(`Unknown effect ${unknown.join(", ")}; known: ${effects.map(([name])=>name).join(", ")}.`);
if((options.prompt||options.duration)&&names.length!==1) throw new Error("--prompt and --duration try out one named effect.");
const chosen=effects.filter(([name])=>!names.length||names.includes(name))
 .map(([name,duration,prompt])=>[name,options.duration?Number(options.duration):duration,options.prompt??prompt]);
// The API takes at most 450 characters of text: the family plus one description.
const long=chosen.filter(([,,prompt])=>family.length+1+prompt.length>450);
if(long.length) throw new Error(`Too long for the API (450 characters with the family): ${long.map(([name])=>name).join(", ")}.`);
const key = process.env.ELEVENLABS_API_KEY || (process.env.ELEVENLABS_KEY_FILE ? (await readFile(process.env.ELEVENLABS_KEY_FILE,"utf8")).trim() : "");
if (!key) throw new Error("Set ELEVENLABS_API_KEY or ELEVENLABS_KEY_FILE for development generation.");
const assets=new URL("../src/assets/sounds/",import.meta.url);
const folder=options.out?pathToFileURL(resolve(options.out)+"/"):assets;
await mkdir(folder,{recursive:true});
const made=new Map();
for(const [name,duration,description] of chosen){
 const response=await fetch("https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128",{
  method:"POST",headers:{"xi-api-key":key,"Content-Type":"application/json"},
  body:JSON.stringify({text:`${family} ${description}`,duration_seconds:duration,prompt_influence:0.6,model_id:"eleven_text_to_sound_v2"})
 });
 if(!response.ok) throw new Error(`Sound generation failed for ${name}: HTTP ${response.status} ${(await response.text()).slice(0,300)}`);
 const bytes=Buffer.from(await response.arrayBuffer());
 await writeFile(new URL(`${name}.mp3`,folder),bytes);
 made.set(name,{name,duration,prompt:description,generatedAt:new Date().toISOString()});
 console.log(`Generated ${name}.mp3 (${bytes.length} bytes)`);
}
// Every file keeps the record of how it was made: only the effects generated now get a new one.
let before={};
try{before=JSON.parse(await readFile(new URL("provenance.json",assets),"utf8"));}catch{/* the first generation */}
const kept=new Map((before.effects??[]).map(effect=>[effect.name,{...effect,generatedAt:effect.generatedAt??before.generatedAt}]));
const order=[...effects.map(([name])=>name),...kept.keys()].filter((name,index,all)=>all.indexOf(name)===index);
await writeFile(new URL("provenance.json",folder),JSON.stringify({provider:"ElevenLabs",model:"eleven_text_to_sound_v2",family,
 effects:order.map(name=>made.get(name)??kept.get(name)).filter(Boolean)},null,2)+"\n");
console.log("Saved in "+fileURLToPath(folder));
