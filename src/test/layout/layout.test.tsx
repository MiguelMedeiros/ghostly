import { screen } from "@testing-library/react";
import { Link, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { Block, ButtonGroup, FieldGrid, InputGroup, Page, Row, Section, Truncate } from "../../components/layout";
import { renderApp } from "../render";

// The contract in src/components/layout/README.md, as classes and props: happy-dom has no layout, so how
// these wrap at a given width is the Playwright responsive suite's job. Here: that they ask for it.

describe("Row", () => {
  it("keeps 12rem of text beside the controls when there is a hint, 8rem for a bare label", () => {
    renderApp(<>
      <Row testId="with-hint" label="Relays" hint="Where invites are published" />
      <Row testId="bare" label="Online" />
    </>);
    const withHint = screen.getByText("Relays").closest("[class*='flex-[1_1_']")!;
    const bare = screen.getByText("Online").closest("[class*='flex-[1_1_']")!;
    expect(withHint).toHaveClass("flex-[1_1_12rem]", "min-w-0");
    expect(bare).toHaveClass("flex-[1_1_8rem]", "min-w-0");
    expect(screen.getByText("Where invites are published")).toHaveClass("break-words");
  });

  it("wraps as a whole, and its controls wrap among themselves", () => {
    renderApp(<Row testId="row" label="Mint"><button>Add</button><button>Remove</button></Row>);
    expect(screen.getByTestId("row")).toHaveClass("flex", "flex-wrap");
    const controls = screen.getByRole("button", { name: "Add" }).parentElement!;
    expect(controls).toHaveClass("flex-wrap", "min-w-0", "max-w-full");
    expect(controls).toContainElement(screen.getByRole("button", { name: "Remove" }));
  });

  it("never wraps or shrinks its value, and leaves the value out when there is none", () => {
    const { rerender } = renderApp(<Row testId="row" label="Balance" value="21,000 sat" />);
    expect(screen.getByText("21,000 sat")).toHaveClass("shrink-0", "whitespace-nowrap");
    rerender(<Row testId="row" label="Balance" />);
    expect(screen.queryByText("21,000 sat")).not.toBeInTheDocument();
    expect(screen.getByTestId("row").querySelector(".whitespace-nowrap")).toBeNull();
  });

  it("shows a zero value: only undefined leaves it out", () => {
    renderApp(<Row label="Fees" value={0} />);
    expect(screen.getByText("0")).toHaveClass("shrink-0", "whitespace-nowrap");
  });

  it("puts `leading` before the text, where it does not shrink", () => {
    renderApp(<Row testId="row" label="Alice" leading={<span data-testid="avatar" />} />);
    const leading = screen.getByTestId("avatar").parentElement!;
    expect(leading).toHaveClass("shrink-0");
    expect(leading.compareDocumentPosition(screen.getByText("Alice")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("has no controls container without children", () => {
    renderApp(<Row testId="row" label="Alone" />);
    expect(screen.getByTestId("row").children).toHaveLength(1);
  });
});

describe("Section and Block", () => {
  it("titles a card of rows, and a block is a padded container that does not overflow", () => {
    renderApp(<Section title="Wallet" testId="section"><Block testId="block"><p>Anything</p></Block></Section>);
    expect(screen.getByRole("heading", { level: 2, name: "Wallet" })).toBeInTheDocument();
    expect(screen.getByTestId("section")).toContainElement(screen.getByTestId("block"));
    expect(screen.getByTestId("block")).toHaveClass("min-w-0");
  });
});

describe("ButtonGroup", () => {
  it("wraps its buttons, and shares the line equally only with `fill`", () => {
    const { rerender } = renderApp(<ButtonGroup className="extra"><button>Pay</button></ButtonGroup>);
    const group = screen.getByRole("button", { name: "Pay" }).parentElement!;
    expect(group).toHaveClass("flex", "flex-wrap", "extra");
    expect(group).not.toHaveClass("*:flex-[1_1_8rem]");
    rerender(<ButtonGroup fill><button>Pay</button></ButtonGroup>);
    expect(screen.getByRole("button", { name: "Pay" }).parentElement).toHaveClass("flex-wrap", "*:flex-[1_1_8rem]");
  });
});

describe("InputGroup", () => {
  it("keeps 12rem for the field and never shrinks its buttons", () => {
    renderApp(<InputGroup><input aria-label="URL" /><button>Add</button></InputGroup>);
    const group = screen.getByRole("textbox", { name: "URL" }).parentElement!;
    expect(group.tagName).toBe("DIV");
    expect(group).toHaveClass("flex-wrap", "[&>input]:flex-[1_1_12rem]", "[&>button]:shrink-0", "*:min-w-0");
  });

  it("is the form itself with as=\"form\", and submits it", async () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    const { user } = renderApp(<InputGroup as="form" onSubmit={onSubmit}><input aria-label="Passphrase" /><button>Restore</button></InputGroup>);
    const form = screen.getByRole("textbox", { name: "Passphrase" }).parentElement!;
    expect(form.tagName).toBe("FORM");
    expect(form).toHaveClass("flex-wrap", "[&>input]:flex-[1_1_12rem]");
    await user.type(screen.getByRole("textbox", { name: "Passphrase" }), "words{Enter}");
    await user.click(screen.getByRole("button", { name: "Restore" }));
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });
});

describe("FieldGrid", () => {
  it("fits as many 12rem columns as it can, at most two, by default", () => {
    renderApp(<FieldGrid><input aria-label="A" /></FieldGrid>);
    const grid = screen.getByRole("textbox", { name: "A" }).parentElement!;
    expect(grid).toHaveClass("grid", "gap-2");
    expect(grid.style.gridTemplateColumns).toBe("repeat(auto-fit, minmax(max(min(100%, 12rem), (100% - 1 * 0.5rem) / 2), 1fr))");
  });

  it("takes its own minimum and maximum", () => {
    renderApp(<FieldGrid min="9rem" max={3}><input aria-label="A" /></FieldGrid>);
    expect(screen.getByRole("textbox", { name: "A" }).parentElement!.style.gridTemplateColumns)
      .toBe("repeat(auto-fit, minmax(max(min(100%, 9rem), (100% - 2 * 0.5rem) / 3), 1fr))");
  });
});

describe("Truncate", () => {
  it("cuts a long value on one line and puts all of it in the tooltip", () => {
    const url = "https://mint.example.com/a/very/long/path";
    renderApp(<Truncate className="text-xs">{url}</Truncate>);
    expect(screen.getByText(url)).toHaveClass("block", "truncate", "text-xs");
    expect(screen.getByText(url)).toHaveAttribute("title", url);
  });

  it("takes a tooltip of its own", () => {
    renderApp(<Truncate title="Full host">mint.example…</Truncate>);
    expect(screen.getByText("mint.example…")).toHaveAttribute("title", "Full host");
  });
});

describe("Page", () => {
  it("goes back where the user came from", async () => {
    // Two entries in the router's history: the chat list, then the wallet opened from it.
    const { user } = renderApp(<Routes>
      <Route path="/" element={<Link to="/wallet">Open wallet</Link>} />
      <Route path="/wallet" element={<Page title="Wallet"><p>Body</p></Page>} />
    </Routes>);
    await user.click(screen.getByRole("link", { name: "Open wallet" }));
    expect(screen.getByRole("heading", { level: 1, name: "Wallet" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("link", { name: "Open wallet" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Wallet" })).not.toBeInTheDocument();
  });

  it("shows trailing controls in the header, and the body is the page's size container", () => {
    renderApp(<Page title="Settings" trailing={<button>Online</button>} testId="page"><p>Body</p></Page>);
    const header = screen.getByRole("banner");
    expect(header).toHaveClass("flex-wrap");
    expect(header).toContainElement(screen.getByRole("button", { name: "Online" }));
    expect(screen.getByRole("button", { name: "Online" }).parentElement).toHaveClass("shrink-0", "ml-auto");
    const body = screen.getByTestId("page").querySelector("[data-page-body]")!;
    expect(body).toHaveClass("@container/page");
    expect(body).toContainElement(screen.getByText("Body"));
  });

  it("has no trailing slot without controls", () => {
    renderApp(<Page title="Profile"><p>Body</p></Page>);
    expect(screen.getByRole("banner").children).toHaveLength(1);
  });

  it("is lg (max-w-3xl) wide by default, md (max-w-2xl) on request", () => {
    const { rerender } = renderApp(<Page title="Wallet"><p>Body</p></Page>);
    expect(screen.getByText("Body").parentElement).toHaveClass("max-w-3xl", "mx-auto");
    rerender(<Page title="Wallet" width="md"><p>Body</p></Page>);
    expect(screen.getByText("Body").parentElement).toHaveClass("max-w-2xl");
    expect(screen.getByText("Body").parentElement).not.toHaveClass("max-w-3xl");
  });
});
