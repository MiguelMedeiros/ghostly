import React, { useEffect, useState } from "react";
import type { ElementContent, Root } from "hast";
import { useI18n } from "../../contexts/I18nContext";
import { CopyButton } from "./CopyButton";

/** highlight.js's tree as elements: spans with its class names, and text. Nothing else is drawn. */
function fromTree(nodes: ElementContent[], key = ""): React.ReactNode[] {
  return nodes.map((node, i) => {
    if (node.type === "text") return node.value;
    if (node.type !== "element") return null;
    const names = node.properties?.className;
    return (
      <span key={key + i} className={Array.isArray(names) ? names.join(" ") : undefined}>
        {fromTree(node.children, `${key}${i}.`)}
      </span>
    );
  });
}

/**
 * A fenced code block: monospace, scrolling sideways rather than wrapping, with its language and a Copy button.
 * Highlighting loads on first use (./highlight, lowlight + a few highlight.js grammars) and replaces the plain
 * text when it arrives; a language the build does not know stays plain.
 */
export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const { t } = useI18n();
  const [tree, setTree] = useState<Root | null>(null);
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
      <pre dir="ltr"><code className="hljs">{tree ? fromTree(tree.children as ElementContent[]) : code}</code></pre>
    </div>
  );
}
