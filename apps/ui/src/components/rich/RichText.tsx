import React, { useMemo, useState, type ComponentType } from "react";
import { useI18n } from "../../contexts/I18nContext";
import { playCue, useCueChat } from "../../lib/cues";
import { parseMessage, type Block, type ListBlock, type Segment } from "../../lib/parse";
import { markMentions, type MentionView } from "../../lib/parse/mentions";
import { Highlight } from "../chat/ChatSearch";
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

/**
 * Elements one message may draw for its formatting (spans, code, spoilers, atoms, list items). Past them the rest is
 * plain text, one node: a contact's 16 KiB of `||a||`, `- a` or `1:00 UTC` drew 2,500-12,000 elements and up to 2,666
 * Tab stops per bubble, and a chat with a few dozen of them took 1.5-2.1 s of long tasks and 300-500 MB at every open
 * (agents#1749). A real message's formatting stays well under it.
 */
export const RICH_ELEMENT_BUDGET = 300;
/**
 * What each costs of it: a styled span or code one element; a list item three; a spoiler or an atom (a link, a time, a
 * name: a button or a link of its own, often several elements) five, so a message has at most 60 such keyboard stops.
 */
const COST = { plain: 1, item: 3, stop: 5 } as const;
const costOf = (segment: Segment): number => (segment.type === "atom" || (segment.type === "span" && segment.style === "spoiler") ? COST.stop : COST.plain);

/** What a message may still draw (`RICH_ELEMENT_BUDGET`), spent as it is drawn. */
interface Budget { left: number }

/** Masks a spoiler's text drawn as plain text past the budget: still hidden, at the length it had. */
const masked = (text: string) => text.replace(/\S/gu, "▒");

/** A segment as plain text, past the budget: a spoiler's still covered. */
function plain(segment: Segment, hidden = false): string {
  switch (segment.type) {
    case "text": case "code": case "atom": return hidden ? masked(segment.text) : segment.text;
    case "span": return segment.children.map((child) => plain(child, hidden || segment.style === "spoiler")).join("");
  }
}

function segments(list: Segment[], sentAt: number | undefined, budget: Budget, key = "", term?: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  for (let i = 0; i < list.length; i++) {
    const segment = list[i]!, k = key + i;
    if (segment.type !== "text" && budget.left < costOf(segment)) {
      // Spent: the rest of these segments as one text.
      const rest = list.slice(i).map((s) => plain(s)).join("");
      out.push(term ? <Highlight key={k} text={rest} term={term} /> : rest);
      break;
    }
    if (segment.type !== "text") budget.left -= costOf(segment);
    switch (segment.type) {
      case "text":
        out.push(term ? <Highlight key={k} text={segment.text} term={term} /> : segment.text);
        break;
      case "code":
        out.push(<code key={k} dir="ltr" className="rich-code">{segment.text}</code>);
        break;
      case "span": {
        const inner = segments(segment.children, sentAt, budget, `${k}.`, term);
        if (segment.style === "bold") out.push(<strong key={k} className="font-semibold">{inner}</strong>);
        else if (segment.style === "italic") out.push(<em key={k}>{inner}</em>);
        else if (segment.style === "strike") out.push(<s key={k}>{inner}</s>);
        else out.push(<Spoiler key={k}>{inner}</Spoiler>);
        break;
      }
      case "atom": {
        // Each atom is isolated from the text around it: a direction control in the message cannot reorder a link,
        // a name or a time, and one inside an atom stops at its edge.
        const View = VIEWS[segment.kind] as ComponentType<AtomViewProps> | undefined;
        out.push(<bdi key={k}>{View ? <View atom={segment} sentAt={sentAt} /> : segment.text}</bdi>);
        break;
      }
    }
  }
  return out;
}

/**
 * A list with the author's own markers ("2)" stays "2)"), each item's text hanging beside its marker when it wraps,
 * and the lists under an item inside it. Bullets are hidden from screen readers (the list says it is one); numbers
 * are read as written.
 */
/** A list's items as plain lines, past the budget. */
function listLines(list: ListBlock, depth = 0): string[] {
  return list.items.flatMap((item) => [`${"  ".repeat(depth)}${item.marker} ${item.segments.map((s) => plain(s)).join("")}`, ...item.children.flatMap((child) => listLines(child, depth + 1))]);
}

function listView(list: ListBlock, sentAt: number | undefined, budget: Budget, k: string, term?: string): React.ReactNode {
  const Tag = list.ordered ? "ol" : "ul";
  // Room for the widest marker, so the items' text lines up ("9." and "10.").
  const widest = list.ordered ? list.items.reduce((most, item) => Math.max(most, item.marker.length), 1) : 1;
  const items: React.ReactNode[] = [];
  let rest: string | undefined;
  for (let i = 0; i < list.items.length; i++) {
    const item = list.items[i]!;
    if (budget.left < COST.item) { rest = listLines({ ...list, items: list.items.slice(i) }).join("\n"); break; }
    budget.left -= COST.item;
    items.push(
      <li key={i} value={item.number} className="rich-li">
        <span aria-hidden={list.ordered ? undefined : true} className="rich-li-marker">{item.marker}</span>
        <span className="rich-li-body">
          {segments(item.segments, sentAt, budget, `${k}.${i}.`, term)}
          {item.children.map((child, j) => <React.Fragment key={j}>{listView(child, sentAt, budget, `${k}.${i}.c${j}`, term)}</React.Fragment>)}
        </span>
      </li>,
    );
  }
  return (
    <React.Fragment key={k}>
      {items.length > 0 && (
        <Tag role="list" data-testid="rich-list" className="rich-list" style={{ "--rich-marker": `${widest}ch` } as React.CSSProperties}>
          {items}
        </Tag>
      )}
      {rest !== undefined && <div data-testid="rich-rest" className="whitespace-pre-wrap">{term ? <Highlight text={rest} term={term} /> : rest}</div>}
    </React.Fragment>
  );
}

function blockView(block: Block, sentAt: number | undefined, budget: Budget, k: string, term?: string): React.ReactNode {
  switch (block.type) {
    case "codeblock":
      return <CodeBlock key={k} code={block.code} lang={block.lang} />;
    case "paragraph":
      return <React.Fragment key={k}>{segments(block.segments, sentAt, budget, `${k}.`, term)}</React.Fragment>;
    case "list":
      return listView(block, sentAt, budget, k, term);
    case "quote":
      return <blockquote key={k} data-testid="rich-quote" className="rich-quote">{block.blocks.map((inner, i) => blockView(inner, sentAt, budget, `${k}.${i}`, term))}</blockquote>;
    case "heading":
      return <div key={k} data-testid="rich-heading" data-level={block.level} className="rich-heading">{segments(block.segments, sentAt, budget, `${k}.`, term)}</div>;
  }
}

/**
 * A message's text as it reads: formatting, code, spoilers, links, lists, quotes, headings and the other atoms
 * (apps/ui/src/lib/parse). The text is sent as typed; this is only how it shows. A message with a block (code, a list, a
 * quote, a heading) is a block itself; otherwise it stays inline, so the time can sit at the end of its last line.
 * `highlight`: a chat search's words, marked where the plain text holds them.
 */
export function RichText({ text, sentAt, className, testId, mentions, highlight }: { text: string; sentAt?: number; className?: string; testId?: string; mentions?: readonly MentionView[]; highlight?: string }) {
  // A group message's mentions: their places marked, for the `member-mention` detector (apps/ui/src/lib/parse/mentions.ts).
  const blocks = useMemo(() => mentions?.length ? parseMessage(markMentions(text, mentions), { sentAt, mentions }) : parseMessage(text, { sentAt }), [text, sentAt, mentions]);
  const budget: Budget = { left: RICH_ELEMENT_BUDGET };
  const content = blocks.map((block, i) => blockView(block, sentAt, budget, String(i), highlight));
  return blocks.some((block) => block.type !== "paragraph")
    ? <div data-testid={testId} className={className}>{content}</div>
    : <span data-testid={testId} className={className}>{content}</span>;
}
