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
export function ReferenceMarkdown({
  body,
  sourcePath,
  idPrefix = "",
}: {
  body: string;
  sourcePath: string;
  idPrefix?: string;
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
    h1: heading("h1"),
    h2: heading("h2"),
    h3: heading("h3"),
    h4: heading("h4"),
    h5: heading("h5"),
    h6: heading("h6"),
    table: ({ children }) => (
      <div
        className="reference-table"
        tabIndex={0}
        role="region"
        aria-label="Scrollable documentation table"
      >
        <table>{children}</table>
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
          <span className="reference-external"> ↗ repository</span>
        )}
      </a>
    ),
  };
  return (
    <Markdown
      remarkPlugins={[remarkGfm, headingIds]}
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
