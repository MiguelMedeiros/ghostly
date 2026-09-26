import { Component, type ErrorInfo, type ReactNode } from "react";
import { useI18n } from "../contexts/I18nContext";

/** What a message that failed to draw shows instead: a note, and its text as written, with nothing read into it. */
export function Unshowable({ text, fromMe }: { text: unknown; fromMe: boolean }) {
  const { t } = useI18n();
  return (
    <div data-testid="message-unshowable" data-message-row className={`flex ${fromMe ? "justify-end" : "justify-start"} mb-3.5 px-[63px] max-md:px-2.5`}>
      <div className={`max-w-[85%] rounded-[7.5px] px-[9px] pt-[6px] pb-[8px] text-text-primary text-[14.2px] leading-[19px] ${fromMe ? "bg-sent-bg" : "bg-received-bg"}`}>
        <p className="italic text-text-secondary">{t("chat.rich.unshowable")}</p>
        {typeof text === "string" && text && <p dir="auto" className="mt-1 whitespace-pre-wrap wrap-break-word">{text}</p>}
      </div>
    </div>
  );
}

/**
 * One message's own boundary: whatever a peer put in a message, a bubble that throws while drawing shows a note
 * in its place, and the chat and the rest of the app go on (the app-wide boundary is the last line, not this).
 */
export class MessageBoundary extends Component<{ text: unknown; fromMe: boolean; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error("Ghostly message error", error, info.componentStack); }
  render() {
    return this.state.failed ? <Unshowable text={this.props.text} fromMe={this.props.fromMe} /> : this.props.children;
  }
}
