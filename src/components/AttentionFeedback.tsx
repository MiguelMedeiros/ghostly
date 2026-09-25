import {useEffect} from "react";
import {engine} from "@ghostly/browser/platform/engine";
import type {AttentionEvent} from "@ghostly/browser/shared/rpc";
import {installAudioGestures,playSound} from "../lib/sounds";
import {showPrivateNotification} from "../lib/notifications";
import {loadSettings} from "../lib/settings";
import {attentionOutcome,chatOfLink,mutedUntil} from "../lib/chatMute";
import {useI18n} from "../contexts/I18nContext";

const seen=new Set<string>();
/** The engine sends live facts separately from replayed snapshots. */
export function AttentionFeedback(){
  const {t}=useI18n();
  useEffect(()=>installAudioGestures(),[]);
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
      // A muted chat's messages arrive as ever, without a sound or a notification (src/lib/chatMute.ts).
      const chat=chatOfLink(event.linkId,engine.state?.links);
      const muted=!!chat && mutedUntil(chat)!==undefined;
      const background=document.visibilityState==="hidden" || !document.hasFocus();
      const outcome=attentionOutcome(event.type,muted,loadSettings().notifications,background);
      if(outcome.sound) playSound(event.type);
      if(outcome.notice) await showPrivateNotification(event.id,t("settings.privateNotice"));
    };
    if(navigator.locks) void navigator.locks.request("ghostly-feedback",run);
    else void run();
  }),[t]);
  return null;
}
