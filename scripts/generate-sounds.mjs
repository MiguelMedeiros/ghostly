import {mkdir,writeFile,readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
const key = process.env.ELEVENLABS_API_KEY || (process.env.ELEVENLABS_KEY_FILE ? (await readFile(process.env.ELEVENLABS_KEY_FILE,"utf8")).trim() : "");
if (!key) throw new Error("Set ELEVENLABS_API_KEY or ELEVENLABS_KEY_FILE for development generation.");
const family="Original minimal interface sound for a calm private messaging app. Soft rounded glass and airy felt mallet texture, warm, clean, understated, no harsh frequencies, no hiss, no voice, no music, no recognizable brand melody. Low-intensity intimate sound, clean silence around the effect.";
const effects=[
 ["message",0.5,"One soft rising two-note droplet, incoming message. Fast gentle attack and very short decay."],
 ["sent",0.5,"One soft tiny upward pluck and airy flick, message sent, shorter and quieter than an incoming alert."],
 ["coin",0.7,"Two warm rounded glass notes, quietly positive, wallet funds received and confirmed. No metallic cash register."],
 ["confirmed",0.6,"One warm low pluck resolving into a softer high note, wallet payment completed. Calm confirmation."],
 ["request",0.5,"Two small muted taps, gentle request, unobtrusive."],
 ["ring",2.5,"A gentle three-note invitation to an incoming call, followed by generous silence, suitable for repeating. Soft marimba-like glass, not alarming."],
 ["ringback",2.5,"One low soft resonant pulse followed by generous silence, waiting for a call to be answered."],
 ["hangup",0.5,"Two very soft descending rounded plucks, a call has ended, calm and brief."]
];
const folder=new URL("../src/assets/sounds/",import.meta.url);
await mkdir(folder,{recursive:true});
for(const [name,duration,description] of effects){
 const response=await fetch("https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128",{
  method:"POST",headers:{"xi-api-key":key,"Content-Type":"application/json"},
  body:JSON.stringify({text:`${family} ${description}`,duration_seconds:duration,prompt_influence:0.6,model_id:"eleven_text_to_sound_v2"})
 });
 if(!response.ok) throw new Error(`Sound generation failed for ${name}: HTTP ${response.status}`);
 const bytes=Buffer.from(await response.arrayBuffer());
 await writeFile(new URL(`${name}.mp3`,folder),bytes);
 console.log(`Generated ${name}.mp3 (${bytes.length} bytes)`);
}
await writeFile(new URL("provenance.json",folder),JSON.stringify({provider:"ElevenLabs",model:"eleven_text_to_sound_v2",generatedAt:new Date().toISOString(),family,effects:effects.map(([name,duration,prompt])=>({name,duration,prompt}))},null,2)+"\n");
console.log("Saved local assets in "+fileURLToPath(folder));
