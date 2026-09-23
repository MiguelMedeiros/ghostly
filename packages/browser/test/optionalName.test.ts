import {afterEach,expect,it,vi} from "vitest";
import {loadSettings,saveSettings} from "../../../src/lib/settings";
afterEach(()=>vi.unstubAllGlobals());
it("starts anonymous, preserves existing names, and persists an explicitly cleared name",()=>{
  const data=new Map<string,string>();
  vi.stubGlobal("localStorage",{getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>data.set(k,v)});
  expect(loadSettings().defaultNickname).toBe("");
  saveSettings({...loadSettings(),defaultNickname:"Midnight"});
  expect(loadSettings().defaultNickname).toBe("Midnight");
  saveSettings({...loadSettings(),defaultNickname:""});
  expect(loadSettings().defaultNickname).toBe("");
});
