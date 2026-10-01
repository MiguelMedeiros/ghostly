import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeProjectLinks } from "../../components/HomeProjectLinks";
import { UpdateBanner } from "../../components/UpdateBanner";
import { desktopUrl, externalLinkProps } from "../../lib/externalLink";
import { renderApp } from "../render";

// covers: app.external-links, app.project-links

/*
 * A link to another site opens outside the app on every platform. A browser page opens a new tab from the link itself;
 * the Desktop WebView opens none (WKWebView, as Tauri sets it up, drops a new-window request), so there the link hands
 * the address to the system browser (`open_web_link`). Every such link takes `externalLinkProps`, and the scan below
 * fails on a `target="_blank"` written anywhere else.
 */

const tauri = vi.hoisted(() => ({ invoke: vi.fn(async (_command: string, _args?: unknown): Promise<unknown> => undefined) }));
// The UI tests alias every `@tauri-apps/api/*` to one stand-in (packages/browser/src/platform/tauri.ts): one mock.
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, listen: async () => () => {}, getVersion: async () => "0.4.0" }));

const update = vi.hoisted(() => ({
  update: { version: "0.5.0", apply: "manual" },
  dismissed: false,
  stage: "idle",
  progress: 0,
  error: undefined,
  install: async () => {},
  dismiss: () => {},
  downloadUrl: "https://github.com/MiguelMedeiros/ghostly/releases/tag/v0.5.0",
}));
vi.mock("../../contexts/UpdateContext", () => ({ useUpdate: () => update }));

const SRC = join(fileURLToPath(import.meta.url), "../../..");
const HOME = "src/lib/externalLink.ts";

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "test" ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/**
 * The lines of `text` that spell `_blank` as a string: `target="_blank"`, `target={"_blank"}`, `target: "_blank"`,
 * `window.open(url, "_blank")`. Each asks the browser for a new window, which the Desktop WebView never opens.
 */
function blanks(file: string, text: string): number[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lines: number[] = [];
  const visit = (node: ts.Node) => {
    const parts = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? [node.text]
      : ts.isTemplateExpression(node) ? [node.head.text, ...node.templateSpans.map((span) => span.literal.text)]
      : [];
    if (parts.some((part) => part.trim().toLowerCase() === "_blank")) lines.push(source.getLineAndCharacterOfPosition(node.getStart()).line + 1);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return lines;
}

const setDesktop = (on: boolean) => {
  const w = window as unknown as { __TAURI_INTERNALS__?: object };
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
};
/** Clicks `link` as a mouse does; true when the page kept the browser from following it. */
const click = (link: HTMLElement) => !fireEvent.click(link, { button: 0 });
const anchor = (href: string, options?: Parameters<typeof externalLinkProps>[1]) =>
  renderApp(<a {...externalLinkProps(href, options)}>link</a>).container.querySelector("a")!;

beforeEach(() => { tauri.invoke.mockReset(); tauri.invoke.mockResolvedValue(undefined); });
afterEach(() => setDesktop(false));

describe("a new window is asked for only through externalLinkProps", () => {
  it("no file in apps/ui/src/ spells _blank but apps/ui/src/lib/externalLink.ts", () => {
    const offenders = sources(SRC)
      .map((file) => ({ name: relative(join(SRC, ".."), file), lines: blanks(file, readFileSync(file, "utf8")) }))
      .filter(({ name, lines }) => name !== HOME && lines.length > 0)
      .map(({ name, lines }) => `${name}:${lines.join(",")} (use externalLinkProps from ${HOME})`);
    expect(offenders).toEqual([]);
  });

  it("the scan sees every way of writing it, and the one it allows", () => {
    const sample = [
      `const a = <a href={u} target="_blank">x</a>;`,
      `const b = <a href={u} target={"_BLANK"}>x</a>;`,
      "const c = { target: `_blank` };",
      `window.open(u, "_blank");`,
      `const d = <a href={u} target="_self" title="blank">x</a>;`,
    ].join("\n");
    expect(blanks("sample.tsx", sample)).toEqual([1, 2, 3, 4]);
    expect(blanks(HOME, readFileSync(join(SRC, "lib/externalLink.ts"), "utf8"))).toHaveLength(1);
  });
});

describe("externalLinkProps", () => {
  it("on the web leaves the click to the link: a new tab, no opener, no referrer", () => {
    const link = anchor("https://example.com/a");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(click(link)).toBe(false);
    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  it("on Desktop hands the address to the system browser", () => {
    setDesktop(true);
    expect(click(anchor("https://example.com/a?b=c#d"))).toBe(true);
    expect(tauri.invoke.mock.calls).toEqual([["open_web_link", { url: "https://example.com/a?b=c#d" }]]);
  });

  // Rust takes plain ASCII only (is_web_link); the raw address was refused and the click did nothing.
  it("on Desktop sends an address with other letters as a browser would: percent-encoded, the host in punycode", () => {
    setDesktop(true);
    expect(click(anchor("https://pt.wikipedia.org/wiki/São_Paulo"))).toBe(true);
    expect(click(anchor("https://münchen.de/straße?q=ção#açaí"))).toBe(true);
    expect(tauri.invoke.mock.calls).toEqual([
      ["open_web_link", { url: "https://pt.wikipedia.org/wiki/S%C3%A3o_Paulo" }],
      ["open_web_link", { url: "https://xn--mnchen-3ya.de/stra%C3%9Fe?q=%C3%A7%C3%A3o#a%C3%A7a%C3%AD" }],
    ]);
  });

  it("keeps the address as given in the link itself", () => {
    expect(anchor("https://pt.wikipedia.org/wiki/São_Paulo")).toHaveAttribute("href", "https://pt.wikipedia.org/wiki/São_Paulo");
  });

  it("on Desktop leaves anything but an http(s) address alone", () => {
    setDesktop(true);
    for (const href of ["nostrconnect://abc", "mailto:a@b.example", "javascript:alert(1)", "not a url"]) {
      expect(click(anchor(href))).toBe(false);
    }
    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  it("uses the command it is given and says when Desktop refused", async () => {
    setDesktop(true);
    tauri.invoke.mockRejectedValue("Not a Ghostly project link");
    const onError = vi.fn();
    click(anchor("https://github.com/MiguelMedeiros/ghostly", { command: "open_project_link", onError }));
    expect(tauri.invoke.mock.calls).toEqual([["open_project_link", { url: "https://github.com/MiguelMedeiros/ghostly" }]]);
    await waitFor(() => expect(onError).toHaveBeenCalledWith("Not a Ghostly project link"));
  });

  it("desktopUrl: only http(s), in ASCII", () => {
    expect(desktopUrl("HTTPS://Example.COM/a b")).toBe("https://example.com/a%20b");
    expect(desktopUrl("ftp://example.com")).toBeUndefined();
    expect(desktopUrl("/relative")).toBeUndefined();
  });
});

describe("links that had no way out on Desktop", () => {
  it("the update banner's Download opens the release page", () => {
    setDesktop(true);
    renderApp(<UpdateBanner />);
    const link = screen.getByRole("link", { name: "Download" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(click(link)).toBe(true);
    expect(tauri.invoke.mock.calls).toEqual([["open_web_link", { url: update.downloadUrl }]]);
  });

  it("Home's GitHub link goes through open_project_link, and says when it could not open", async () => {
    setDesktop(true);
    tauri.invoke.mockRejectedValue("refused");
    renderApp(<HomeProjectLinks />);
    expect(click(screen.getByRole("link", { name: "GitHub" }))).toBe(true);
    expect(tauri.invoke.mock.calls).toEqual([["open_project_link", { url: "https://github.com/MiguelMedeiros/ghostly" }]]);
    expect(await screen.findByRole("status")).toBeInTheDocument();
    tauri.invoke.mockResolvedValue(undefined);
    click(screen.getByRole("link", { name: "GitHub" }));
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });
});
