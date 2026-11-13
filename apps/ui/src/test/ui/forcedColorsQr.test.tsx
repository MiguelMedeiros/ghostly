import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { QRCodeDisplay } from "../../components/QRCode";
import { renderApp } from "../render";

// covers: app.accessibility, invite.qr.show

/**
 * Forced colors (Windows Contrast themes) replace backgrounds with the page's: the QR box's white went with them, and
 * in a dark theme only the SVG's own 2-module margin stayed light, with the black page right after. A QR asks for a
 * 4-module light quiet zone around black modules: the box is an image, kept as drawn (`forced-color-adjust: none`,
 * which only acts in forced colors).
 */
describe("the QR in forced colors", () => {
  it("keeps its white box and its own colours", () => {
    renderApp(<QRCodeDisplay value="https://ghostly.tools/#example" />);
    const box = screen.getByTestId("invite-qr");
    expect(box).toHaveClass("bg-white", "p-4", "forced-color-adjust-none");
    const svg = box.querySelector("svg")!;
    const [light, dark] = [...svg.querySelectorAll("path")].map((path) => path.getAttribute("fill"));
    expect(light).toBe("#ffffff");
    expect(dark).toBe("#0b0f1a");
  });
});
