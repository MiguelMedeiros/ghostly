import {useEffect} from "react";
import {engine} from "@ghostly/browser/platform/engine";
import type {AttentionEvent} from "@ghostly/browser/shared/rpc";
import {installAudioGestures,playSound} from "../lib/sounds";
import {showPrivateNotification} from "../lib/notifications";
import {loadSettings} from "../lib/settings";
import {attentionOutcome,chatOfLink,mutedFor} from "../lib/chatMute";
import {eventSound,playCue} from "../lib/cues";
import {setDeckSwitchSound} from "./deck/Deck";
import {useI18n} from "../contexts/I18nContext";

const seen=new Set<string>();
/** The engine sends live facts separately from replayed snapshots. */
export function AttentionFeedback(){
  const {t}=useI18n();
  useEffect(()=>installAudioGestures(),[]);
  useEffect(()=>{setDeckSwitchSound(()=>playCue("slide"));return ()=>setDeckSwitchSound(undefined);},[]);
  useEffect(()=>engine.onAttention((event:AttentionEvent)=>{
    if(Date.now()-event.at>5000 || seen.has(event.id)) return;
    seen.add(event.id);
    const run=async()=>{
      // Extension pages may share one engine. Claim one presentation per event.
      const key="ghostly_feedback_claims";
      let claims:string[]=[];
      try {claims=JSON.parse(localStorage.getItem(key)??"[]") as string[];}catch{/* unavailable */}
      if(claims.includes(event.id)) return;
      try{localStorage.setItem(key,JSON.stringify([...claims.slice(-255),event.id]));}catch{/* in-memory dedupe still applies */}
      // A muted chat's messages arrive as ever, without a sound or a notification (src/lib/chatMute.ts), unless
      // one names me in a group that still notifies mentions.
      const chat=chatOfLink(event.linkId,engine.state?.links);
      const muted=mutedFor(chat,!!event.mention);
      const background=document.visibilityState==="hidden" || !document.hasFocus();
      // A fact that had no sound before the categories: its cue alone, under the cue's own rules (src/lib/cues.ts).
      if(event.type==="cue"){ if(event.cue) playCue(event.cue,{chat,key:event.id}); return; }
      const notifications=loadSettings().notifications;
      const outcome=attentionOutcome(event.type,muted,notifications,background);
      if(outcome.sound) playSound(eventSound({...event,type:event.type},notifications));
      if(outcome.notice) await showPrivateNotification(event.id,t("settings.privateNotice"));
    };
    if(navigator.locks) void navigator.locks.request("ghostly-feedback",run);
    else void run();
  }),[t]);
  return null;
}
