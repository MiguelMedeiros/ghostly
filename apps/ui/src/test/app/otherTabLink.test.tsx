import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { OtherTab } from "../../components/OtherTab";
import { translatorFor } from "../../locales";
import { forwardLink, linkInAddress, takeLinks } from "../../lib/otherTabLink";

// covers: app.single-peer-per-browser

/*
 * A link opened in a tab that waits for the profile's lock (apps/ui/src/lib/otherTabLink.ts): it goes to the tab
 * holding that profile, once, and the waiting tab hears it was taken; another profile's tab never takes it.
 */

const CODE = "ghostly1p" + "q".repeat(211);
const stops: (() => void)[] = [];
afterEach(() => { while (stops.length) stops.pop()!(); });

describe("linkInAddress", () => {
  it("reads the links the app's intakes take, and nothing else", () => {
    expect(linkInAddress(`#${CODE}`)).toBe(CODE);
    expect(linkInAddress(`#/${CODE}`)).toBe(`/${CODE}`);
    expect(linkInAddress("#web%2Bghostly%3Aghostly1abc")).toBe("web%2Bghostly%3Aghostly1abc");
    expect(linkInAddress("#/join/group2/abc")).toBe("/join/group2/abc");
    expect(linkInAddress("#work#ghostly1zabc")).toBe("work#ghostly1zabc");
    for (const plain of ["", "#", "#/", "#/chat/0123abcd", "#/settings", "#/shared"]) expect(linkInAddress(plain)).toBeNull();
  });
});

describe("a link handed to the tab that holds the profile", () => {
  it("is opened there once, and the waiting tab hears it was taken", async () => {
    const open = vi.fn();
    stops.push(takeLinks("ghostly-peer", open));
    const taken = vi.fn();
    stops.push(forwardLink("ghostly-peer", CODE, taken, 20));
    await vi.waitFor(() => expect(taken).toHaveBeenCalledTimes(1));
    expect(open).toHaveBeenCalledExactlyOnceWith(CODE);
    // Asked no more once taken: nothing reaches the holder a second time.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("waits for a holder that starts listening late, and another profile's tab never takes it", async () => {
    const other = vi.fn();
    stops.push(takeLinks("ghostly-peer-work", other));
    const taken = vi.fn();
    stops.push(forwardLink("ghostly-peer", CODE, taken, 20));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(taken).not.toHaveBeenCalled();
    const open = vi.fn();
    stops.push(takeLinks("ghostly-peer", open));
    await vi.waitFor(() => expect(taken).toHaveBeenCalledTimes(1));
    expect(open).toHaveBeenCalledExactlyOnceWith(CODE);
    expect(other).not.toHaveBeenCalled();
  });

  it("stops when this tab takes the lock itself before anyone took it", async () => {
    const taken = vi.fn();
    const stop = forwardLink("ghostly-peer", CODE, taken, 20);
    stop();
    const open = vi.fn();
    stops.push(takeLinks("ghostly-peer", open));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(open).not.toHaveBeenCalled();
    expect(taken).not.toHaveBeenCalled();
  });
});

describe("the waiting screen", () => {
  it("says the link opens here if the other tab closes, and where it went once taken", () => {
    const t = translatorFor("en");
    const { rerender } = render(<OtherTab state="link" t={t} />);
    expect(screen.getByTestId("other-tab").textContent).toContain("Close it and this tab opens your link.");
    rerender(<OtherTab state="linkTaken" t={t} />);
    expect(screen.getByTestId("other-tab").textContent).toContain("Your link opened in Ghostly in your other tab.");
  });
});
