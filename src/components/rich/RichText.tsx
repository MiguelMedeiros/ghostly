import React, { useMemo, useState, type ComponentType } from "react";
import { useI18n } from "../../contexts/I18nContext";
import { parseMessage, type Segment } from "../../lib/parse";
import { CodeBlock } from "./CodeBlock";
import { VIEWS, type AtomViewProps } from "./views";
import "./rich-text.css";

/** `||spoiler||`: covered until tapped (or Enter/Space), and read out as hidden text until then. */
function Spoiler({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  const [shown, setShown] = useState(false);
  if (shown) return <span data-testid="rich-spoiler" data-shown="" className="rich-spoiler-shown">{children}</span>;
  return (
    <span
      data-testid="rich-spoiler"
      role="button"
      tabIndex={0}
      aria-label={t("chat.rich.spoiler")}
      className="rich-spoiler"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); setShown(true); }}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setShown(true); } }}
    >
      <span aria-hidden="true" inert>{children}</span>
    </span>
  );
}

function segments(list: Segment[], sentAt: number | undefined, key = ""): React.ReactNode[] {
  return list.map((segment, i) => {
    const k = key + i;
    switch (segment.type) {
      case "text":
        return segment.text;
      case "code":
        return <code key={k} dir="ltr" className="rich-code">{segment.text}</code>;
      case "span": {
        const inner = segments(segment.children, sentAt, `${k}.`);
        if (segment.style === "bold") return <strong key={k} className="font-semibold">{inner}</strong>;
        if (segment.style === "italic") return <em key={k}>{inner}</em>;
        if (segment.style === "strike") return <s key={k}>{inner}</s>;
        return <Spoiler key={k}>{inner}</Spoiler>;
      }
      case "atom": {
        const View = VIEWS[segment.kind] as ComponentType<AtomViewProps> | undefined;
        return View ? <View key={k} atom={segment} sentAt={sentAt} /> : segment.text;
      }
    }
  });
}

/**
 * A message's text as it reads: formatting, code, spoilers, links and the other atoms (src/lib/parse). The text is
 * sent as typed; this is only how it shows. A message with a code block is a block itself; otherwise it stays
 * inline, so the time can sit at the end of its last line.
 */
export function RichText({ text, sentAt, className, testId }: { text: string; sentAt?: number; className?: string; testId?: string }) {
  const blocks = useMemo(() => parseMessage(text, { sentAt }), [text, sentAt]);
  const content = blocks.map((block, i) =>
    block.type === "codeblock"
      ? <CodeBlock key={i} code={block.code} lang={block.lang} />
      : <React.Fragment key={i}>{segments(block.segments, sentAt, `${i}.`)}</React.Fragment>,
  );
  return blocks.some((block) => block.type === "codeblock")
    ? <div data-testid={testId} className={className}>{content}</div>
    : <span data-testid={testId} className={className}>{content}</span>;
}
