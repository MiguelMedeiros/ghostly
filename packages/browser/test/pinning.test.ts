import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {isSessionPinned, setSessionPinned, setStorageProfile, saveSession, listSessions, deleteSession, loadSession} from "../../../src/lib/storage";
// covers: chats.list.pin
const values = new Map<string,string>();
beforeEach(() => {
  values.clear(); setStorageProfile("");
  vi.stubGlobal("localStorage", {get length(){return values.size;}, key:(i:number)=>[...values.keys()][i], getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>values.set(k,v),removeItem:(k:string)=>values.delete(k)});
  vi.stubGlobal("window", new EventTarget());
});
afterEach(()=>{setStorageProfile("");vi.unstubAllGlobals();});
it("pins paired and legacy chats locally, preserves history, ordering and profile isolation",()=>{
  for (const [id,profile,createdAt] of [["legacy",undefined,1],["paired","paired-chat/1",2]] as const)
    saveSession({id,profile,createdAt,mySeedB64:"seed",peerPubKeyB64:"peer",encKeyB64:"key",messages:[]});
  const original=loadSession("legacy");
  setSessionPinned("legacy",true);
  expect(listSessions().map(s=>s.id)).toEqual(["legacy","paired"]);
  saveSession(original!); // An engine history write must not erase the local pin.
  expect(isSessionPinned("legacy")).toBe(true);
  setSessionPinned("paired",true);
  expect(listSessions().map(s=>s.id)).toEqual(["paired","legacy"]);
  setStorageProfile("other");expect(isSessionPinned("legacy")).toBe(false);
  setStorageProfile("");expect(isSessionPinned("legacy")).toBe(true);
  setSessionPinned("legacy",false);expect(isSessionPinned("legacy")).toBe(false);
  expect(loadSession("legacy")).toEqual(original);
  deleteSession("paired");expect(isSessionPinned("paired")).toBe(false);
});
