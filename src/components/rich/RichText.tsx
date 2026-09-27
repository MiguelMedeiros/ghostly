import React, { useMemo, useState, type ComponentType } from "react";
import { useI18n } from "../../contexts/I18nContext";
import { playCue, useCueChat } from "../../lib/cues";
import { parseMessage, type Block, type ListBlock, type Segment } from "../../lib/parse";
import { markMentions, type MentionView } from "../../lib/parse/mentions";
import { CodeBlock } from "./CodeBlock";
import { VIEWS, type AtomViewProps } from "./views";
import "./rich-text.css";

/** `||spoiler||`: covered until tapped (or Enter/Space), and read out as hidden text until then. */
function Spoiler({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  const [shown, setShown] = useState(false);
  const chat = useCueChat();
  const reveal = () => { setShown(true); playCue("spoiler", { chat }); };
  if (shown) return <span data-testid="rich-spoiler" data-shown="" className="rich-spoiler-shown">{children}</span>;
  return (
    <span
      data-testid="rich-spoiler"
      role="button"
      tabIndex={0}
      aria-label={t("chat.rich.spoiler")}
      className="rich-spoiler"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); reveal(); }}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); reveal(); } }}
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
        // Each atom is isolated from the text around it: a direction control in the message cannot reorder a link,
        // a name or a time, and one inside an atom stops at its edge.
        const View = VIEWS[segment.kind] as ComponentType<AtomViewProps> | undefined;
        return <bdi key={k}>{View ? <View atom={segment} sentAt={sentAt} /> : segment.text}</bdi>;
      }
    }
  });
}

/**
 * A list with the author's own markers ("2)" stays "2)"), each item's text hanging beside its marker when it wraps,
 * and the lists under an item inside it. Bullets are hidden from screen readers (the list says it is one); numbers
 * are read as written.
 */
function ListView({ list, sentAt, k }: { list: ListBlock; sentAt: number | undefined; k: string }) {
  const Tag = list.ordered ? "ol" : "ul";
  // Room for the widest marker, so the items' text lines up ("9." and "10.").
  const widest = list.ordered ? list.items.reduce((most, item) => Math.max(most, item.marker.length), 1) : 1;
  return (
    <Tag role="list" data-testid="rich-list" className="rich-list" style={{ "--rich-marker": `${widest}ch` } as React.CSSProperties}>
      {list.items.map((item, i) => (
        <li key={i} value={item.number} className="rich-li">
          <span aria-hidden={list.ordered ? undefined : true} className="rich-li-marker">{item.marker}</span>
          <span className="rich-li-body">
            {segments(item.segments, sentAt, `${k}.${i}.`)}
            {item.children.map((child, j) => <ListView key={j} list={child} sentAt={sentAt} k={`${k}.${i}.c${j}`} />)}
          </span>
        </li>
      ))}
    </Tag>
  );
}

function blockView(block: Block, sentAt: number | undefined, k: string): React.ReactNode {
  switch (block.type) {
    case "codeblock":
      return <CodeBlock key={k} code={block.code} lang={block.lang} />;
    case "paragraph":
      return <React.Fragment key={k}>{segments(block.segments, sentAt, `${k}.`)}</React.Fragment>;
    case "list":
      return <ListView key={k} list={block} sentAt={sentAt} k={k} />;
    case "quote":
      return <blockquote key={k} data-testid="rich-quote" className="rich-quote">{block.blocks.map((inner, i) => blockView(inner, sentAt, `${k}.${i}`))}</blockquote>;
    case "heading":
      return <div key={k} data-testid="rich-heading" data-level={block.level} className="rich-heading">{segments(block.segments, sentAt, `${k}.`)}</div>;
  }
}

/**
 * A message's text as it reads: formatting, code, spoilers, links, lists, quotes, headings and the other atoms
 * (src/lib/parse). The text is sent as typed; this is only how it shows. A message with a block (code, a list, a
 * quote, a heading) is a block itself; otherwise it stays inline, so the time can sit at the end of its last line.
 */
export function RichText({ text, sentAt, className, testId, mentions }: { text: string; sentAt?: number; className?: string; testId?: string; mentions?: readonly MentionView[] }) {
  // A group message's mentions: their places marked, for the `member-mention` detector (src/lib/parse/mentions.ts).
  const blocks = useMemo(() => mentions?.length ? parseMessage(markMentions(text, mentions), { sentAt, mentions }) : parseMessage(text, { sentAt }), [text, sentAt, mentions]);
  const content = blocks.map((block, i) => blockView(block, sentAt, String(i)));
  return blocks.some((block) => block.type !== "paragraph")
    ? <div data-testid={testId} className={className}>{content}</div>
    : <span data-testid={testId} className={className}>{content}</span>;
}
