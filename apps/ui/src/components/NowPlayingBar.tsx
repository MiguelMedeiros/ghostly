import { useEffect, useRef, useState } from "react";
import { formatVideoDuration } from "@ghostly/core";
import { useOptionalI18n, useT } from "../contexts/I18nContext";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { JUMP_TO } from "../hooks/useJumpTo";
import { languageTag } from "../lib/documentLanguage";
import { pauseHeld, resumeHeld, stopHeld, useNowPlaying } from "../lib/nowPlaying";
import { onVoiceRate, voiceRate } from "../lib/voicePlayback";
import { SpeedPill } from "./voice/VoiceBubble";

/**
 * The voice message or audio file playing on away from its chat (lib/nowPlaying.ts): who sent it and where, play and
 * pause, where it is, the speed voice messages share, and close, which stops it. A tap on it opens its chat at the
 * message, where its bubble takes it back. Nothing while nothing plays away from its bubble.
 */
export function NowPlayingBar({ className = "" }: { className?: string }) {
  const t = useT();
  const nav = useAppNavigation();
  const now = useNowPlaying();
  const locale = languageTag(useOptionalI18n()?.language ?? "en");
  const [rate, setRate] = useState(voiceRate);
  useEffect(() => onVoiceRate(setRate), []);
  const playRef = useRef<HTMLButtonElement>(null);
  if (!now) return null;

  const voice = now.kind === "voice";
  const where = now.chat && now.chat.name !== now.from ? now.chat.name : null;
  const position = formatVideoDuration(now.position * 1000);
  const duration = formatVideoDuration(now.duration * 1000);
  const open = () => {
    if (now.chat) nav.conversation(now.chat.path, now.messageId ? { [JUMP_TO]: now.messageId } : undefined);
  };

  return (
    <section
      role="region"
      aria-label={t("chat.nowPlaying.label")}
      data-testid="now-playing"
      data-state={now.playing ? "playing" : "paused"}
      data-file={now.id}
      className={`flex items-center gap-2 px-2 py-1.5 bg-panel-header border-b border-border text-text-primary ${className}`}
    >
      <button
        ref={playRef}
        type="button"
        data-testid="now-playing-play"
        aria-label={now.playing ? t(voice ? "chat.voice.pause" : "chat.audio.pause") : t(voice ? "chat.voice.play" : "chat.audio.play")}
        onClick={() => (now.playing ? pauseHeld() : resumeHeld())}
        className="w-9 h-9 shrink-0 flex items-center justify-center rounded-full bg-transparent border-none text-text-primary cursor-pointer hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-accent"
      >
        {now.playing ? (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
        ) : (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86A1 1 0 0 0 8 5.14z" /></svg>
        )}
      </button>
      <button
        type="button"
        data-testid="now-playing-open"
        title={t("chat.nowPlaying.open")}
        disabled={!now.chat}
        onClick={open}
        className="flex-1 min-w-0 flex flex-col items-start text-start bg-transparent border-none p-0 rounded cursor-pointer disabled:cursor-default focus-visible:outline-2 focus-visible:outline-accent"
      >
        {/* Each name in its own direction on the element that cuts it: a <bdi> inside a truncating box is cut from the
            box's (the page's) side, so a Latin name in the Arabic app lost its start. */}
        <span className="flex max-w-full min-w-0 text-[13px] font-medium leading-tight" data-testid="now-playing-from">
          <span dir="auto" className="min-w-0 truncate">{now.from}</span>
          {where && <><span className="shrink-0 whitespace-pre"> · </span><span dir="auto" className="min-w-0 truncate">{where}</span></>}
        </span>
        <span dir="auto" className="max-w-full truncate text-[12px] text-text-muted leading-tight" data-testid="now-playing-title">{now.title}</span>
      </button>
      <span className="shrink-0 text-[12px] text-text-muted tabular-nums" data-testid="now-playing-time">
        <span aria-hidden="true">{now.duration > 0 ? `${position} / ${duration}` : position}</span>
        {/* Read out in the app's language, as the bubbles' sliders are. */}
        <span className="sr-only">{now.duration > 0 ? t("chat.media.positionOf", { position, duration }) : position}</span>
      </span>
      <span className="shrink-0 flex text-text-primary">
        <SpeedPill rate={rate} locale={locale} onGone={() => playRef.current?.focus()} />
      </span>
      <button
        type="button"
        data-testid="now-playing-close"
        aria-label={t("chat.nowPlaying.close")}
        title={t("chat.nowPlaying.close")}
        onClick={stopHeld}
        className="w-8 h-8 shrink-0 flex items-center justify-center rounded-full bg-transparent border-none text-text-muted cursor-pointer hover:bg-surface-hover hover:text-text-primary focus-visible:outline-2 focus-visible:outline-accent"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
      </button>
    </section>
  );
}
