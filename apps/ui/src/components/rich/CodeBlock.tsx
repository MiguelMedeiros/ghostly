import React, { useEffect, useMemo, useState } from "react";
import type { ElementContent, Root } from "hast";
import { useI18n } from "../../contexts/I18nContext";
import { matchRanges } from "../../lib/chatSearch";
import { CopyButton } from "./CopyButton";
import { holdsInvisible, showInvisible } from "./invisible";

/** A chat search's matches in the code, and how far the drawing of its tree got. */
interface Marks { ranges: [number, number][]; at: number }

/** highlight.js's tree as elements: spans with its class names, and text, with what falls in it of `marks` marked. Nothing else is drawn. */
function fromTree(nodes: ElementContent[], marks: Marks | undefined, key = ""): React.ReactNode[] {
  return nodes.map((node, i) => {
    if (node.type === "text") {
      if (!marks) return <React.Fragment key={key + i}>{showInvisible(node.value)}</React.Fragment>;
      const start = marks.at;
      marks.at += node.value.length;
      return <React.Fragment key={key + i}>{showInvisible(node.value, start, marks.ranges)}</React.Fragment>;
    }
    if (node.type !== "element") return null;
    const names = node.properties?.className;
    return (
      <span key={key + i} className={Array.isArray(names) ? names.join(" ") : undefined}>
        {fromTree(node.children, marks, `${key}${i}.`)}
      </span>
    );
  });
}

/**
 * The warning over code that holds hidden characters. Its marker is a left-to-right element of its own: bare in an
 * Arabic sentence, its < and > took the sentence's direction and were drawn mirrored around the U (<…+U>).
 */
function HiddenNote({ text }: { text: string }) {
  const [before, after = ""] = text.split("{{marker}}");
  return (
    <p data-testid="rich-codeblock-hidden" role="note" className="rich-codeblock-hidden">
      {before}<bdi dir="ltr">{"<U+…>"}</bdi>{after}
    </p>
  );
}

/**
 * A fenced code block: monospace, scrolling sideways rather than wrapping, with its language and a Copy button.
 * Highlighting loads on first use (./highlight, lowlight + a few highlight.js grammars) and replaces the plain
 * text when it arrives; a language the build does not know stays plain. `highlight`: a chat search's words, marked
 * where the code holds them, across the highlighting's tokens. Code holding a direction control or an invisible
 * character draws each as a marker (showInvisible) and says so on a line of its own; Copy still writes the code as sent.
 */
export function CodeBlock({ code, lang, highlight }: { code: string; lang?: string; highlight?: string }) {
  const { t } = useI18n();
  const [tree, setTree] = useState<Root | null>(null);
  const ranges = useMemo(() => (highlight ? matchRanges(code, highlight) : []), [code, highlight]);
  const hidden = useMemo(() => holdsInvisible(code), [code]);
  useEffect(() => {
    setTree(null);
    if (!lang) return;
    let live = true;
    import("./highlight").then(({ highlight }) => { if (live) setTree(highlight(code, lang)); }, () => {});
    return () => { live = false; };
  }, [code, lang]);
  return (
    <div data-testid="rich-codeblock" data-lang={lang} data-highlighted={tree ? "" : undefined} className="rich-codeblock">
      <div className="rich-codeblock-bar">
        <span>{lang ?? t("chat.rich.code")}</span>
        <CopyButton text={code} label={t("chat.rich.copyCode")} testId="rich-codeblock-copy" />
      </div>
      {hidden && <HiddenNote text={t("chat.rich.hiddenChars")} />}
      <pre dir="ltr"><code className="hljs">{tree
        ? fromTree(tree.children as ElementContent[], ranges.length ? { ranges, at: 0 } : undefined)
        : showInvisible(code, 0, ranges)}</code></pre>
    </div>
  );
}
