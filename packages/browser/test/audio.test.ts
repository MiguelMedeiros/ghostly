import {afterEach, expect, it, vi} from "vitest";
vi.mock("../../../src/lib/settings",()=>({loadSettings:()=>({notifications:{soundEnabled:enabled}})}));
let enabled=true;
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();vi.resetModules();enabled=true;});
it("requires a gesture, cancels an active ring and immediately honors mute",async()=>{
  vi.useFakeTimers();
  const doc=new EventTarget(),win=new EventTarget(),start=vi.fn(),stop=vi.fn();
  vi.stubGlobal("document",doc);vi.stubGlobal("window",win);
  vi.stubGlobal("fetch",vi.fn(async()=>({ok:true,arrayBuffer:async()=>new ArrayBuffer(0)})));
  vi.stubGlobal("AudioContext",class {
    state="running";currentTime=0;destination={};
    decodeAudioData=async()=>({duration:2.48});
    createBufferSource=()=>({buffer:null,connect:()=>({connect:vi.fn()}),start,stop});
    createGain=()=>({gain:{value:0}});
  });
  const {installAudioGestures,playSound,startRinging}=await import("../../../src/lib/sounds");
  const cleanup=installAudioGestures();
  playSound("message");await vi.advanceTimersByTimeAsync(0);expect(start).not.toHaveBeenCalled();
  doc.dispatchEvent(new Event("pointerdown"));await vi.advanceTimersByTimeAsync(0);
  const end=startRinging("ring");await vi.advanceTimersByTimeAsync(0);expect(start).toHaveBeenCalledTimes(1);
  end();expect(stop).toHaveBeenCalledTimes(1);await vi.advanceTimersByTimeAsync(8000);expect(start).toHaveBeenCalledTimes(1);
  playSound("message");await vi.advanceTimersByTimeAsync(0);expect(start).toHaveBeenCalledTimes(2);
  enabled=false;win.dispatchEvent(new Event("settings-updated"));expect(stop).toHaveBeenCalledTimes(2);
  playSound("coin");await vi.advanceTimersByTimeAsync(0);expect(start).toHaveBeenCalledTimes(2);cleanup();
});
