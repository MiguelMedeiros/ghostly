import { Children, isValidElement, type ReactNode } from "react";
import Markdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import GithubSlugger from "github-slugger";
import { resolveReferenceUrl } from "@/lib/references";

function textOf(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) =>
      isValidElement<{ children?: ReactNode }>(child)
        ? textOf(child.props.children)
        : String(child),
    )
    .join("");
}
function Diagram({ source }: { source: string }) {
  const labels = new Map<string, string>();
  const nodePattern = /(\w+)\[(?:"([^"]+)"|([^\]]+))\]/g;
  for (const match of source.matchAll(nodePattern))
    labels.set(match[1], match[2] ?? match[3]);
  const plain = source.replace(nodePattern, "$1");
  const edges = [
    ...plain.matchAll(/(\w+)\s*(-->|-\.\s*(.*?)\s*\.->)\s*(\w+)/g),
  ];
  return (
    <figure className="reference-diagram">
      <figcaption>Architecture diagram · relationships</figcaption>
      {edges.length > 0 && (
        <ol>
          {edges.map((edge, index) => (
            <li key={index}>
              <span>{labels.get(edge[1]) ?? edge[1]}</span>
              <b aria-label={edge[3] || "connects to"}>
                →{edge[3] && <small>{edge[3]}</small>}
              </b>
              <span>{labels.get(edge[4]) ?? edge[4]}</span>
            </li>
          ))}
        </ol>
      )}
      <details open={!edges.length}>
        <summary>Original Mermaid diagram source</summary>
        <pre>
          <code>{source}</code>
        </pre>
      </details>
    </figure>
  );
}

/**
 * Renders a synced reference document with anchored headings and in-site links. Under a page title (`belowTitle`)
 * the document's own "# Title" repeats it, so it is only an anchor (old links to it still land) and the page keeps
 * a single h1.
 */
export function ReferenceMarkdown({
  body,
  sourcePath,
  idPrefix = "",
  repoLabel = "repository",
  belowTitle = false,
}: {
  body: string;
  sourcePath: string;
  idPrefix?: string;
  repoLabel?: string;
  belowTitle?: boolean;
}) {
  type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[]; data?: { hProperties?: Record<string, string> } };
  const headingIds = () => (tree: MarkdownNode) => {
    const slugger = new GithubSlugger();
    const plain = (node: MarkdownNode): string => node.value ?? node.children?.map(plain).join("") ?? "";
    const visit = (node: MarkdownNode) => {
      if (node.type === "heading") node.data = { ...node.data, hProperties: { ...node.data?.hProperties, id: idPrefix + slugger.slug(plain(node)) } };
      node.children?.forEach(visit);
    };
    visit(tree);
  };
  // On a phone a table of three or more columns stacks each row as a card (reader.css), so every cell carries its
  // column's header as a label and the table says it may stack. Stacked, the boxes are blocks, so explicit roles keep
  // it a table for a screen reader.
  type HtmlNode = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HtmlNode[] };
  const tableLabels = () => (tree: HtmlNode) => {
    const text = (node: HtmlNode): string => node.value ?? node.children?.map(text).join("") ?? "";
    const rows = (node: HtmlNode): HtmlNode[] =>
      node.tagName === "tr" ? [node] : (node.children ?? []).flatMap((child) => (child.tagName === "table" ? [] : rows(child)));
    const cells = (row: HtmlNode) => (row.children ?? []).filter((cell) => cell.tagName === "th" || cell.tagName === "td");
    const visit = (node: HtmlNode) => {
      if (node.tagName === "table") {
        const [head, ...body] = rows(node);
        const labels = head ? cells(head).map((cell) => text(cell).trim()) : [];
        if (labels.length >= 3) {
          node.properties = { ...node.properties, dataStack: "", role: "table" };
          const role = (child: HtmlNode, value: string) => (child.properties = { ...child.properties, role: value });
          node.children?.forEach((group) => (group.tagName === "thead" || group.tagName === "tbody") && role(group, "rowgroup"));
          for (const row of [head, ...body]) {
            role(row, "row");
            cells(row).forEach((cell) => role(cell, cell.tagName === "th" ? "columnheader" : "cell"));
          }
          for (const row of body) cells(row).forEach((cell, index) => (cell.properties = { ...cell.properties, dataLabel: labels[index] ?? "" }));
        }
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
  const heading = (Tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6") =>
    function Heading({ children, id }: { children?: ReactNode; id?: string }) {
      return (
        <Tag id={id}>
          {children}
          <a
            className="reference-anchor"
            href={`#${id}`}
            aria-label={`Link to ${textOf(children)}`}
          >
            #
          </a>
        </Tag>
      );
    };
  const components: Components = {
    h1: belowTitle ? ({ id }) => <span id={id} /> : heading("h1"),
    h2: heading("h2"),
    h3: heading("h3"),
    h4: heading("h4"),
    h5: heading("h5"),
    h6: heading("h6"),
    table: ({ node: _node, children, ...props }) => (
      <div
        className="reference-table"
        tabIndex={0}
        role="region"
        aria-label="Scrollable documentation table"
      >
        <table {...props}>{children}</table>
      </div>
    ),
    pre: ({ children }) => {
      const code = Children.toArray(children)[0];
      if (
        isValidElement<{ className?: string; children?: ReactNode }>(code) &&
        code.props.className === "language-mermaid"
      )
        return <Diagram source={textOf(code.props.children)} />;
      return <pre tabIndex={0}>{children}</pre>;
    },
    a: ({ href, children }) => (
      <a href={href}>
        {children}
        {href?.startsWith("https://github.com/") && (
          <span className="reference-external"> ↗ {repoLabel}</span>
        )}
      </a>
    ),
  };
  return (
    <Markdown
      remarkPlugins={[remarkGfm, headingIds]}
      rehypePlugins={[tableLabels]}
      skipHtml
      components={components}
      urlTransform={(url) =>
        defaultUrlTransform(url.startsWith("#") ? `#${idPrefix}${url.slice(1)}` : resolveReferenceUrl(url, sourcePath))
      }
    >
      {body}
    </Markdown>
  );
}
