import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AvatarOpener, AvatarViewer } from "../../components/AvatarViewer";
import { FIT, MAX_SCALE, clamp, laidOut, pinch, toggleAt, zoomAt, type Box } from "../../lib/pictureZoom";
import { renderApp } from "../render";

// covers: files.image.view, profiles.picture.viewer

const PHOTO = "data:image/jpeg;base64,/9j/alice";

/** A phone's screen, and a picture laid out in its middle at 300×200. */
const VIEW: Box = { left: 0, top: 0, width: 400, height: 800 };
const BASE: Box = { left: 50, top: 300, width: 300, height: 200 };

describe("the picture's zoom, as numbers", () => {
  it("zooms around the point given, which stays where it was on the screen", () => {
    const at = { x: 100, y: 350 };
    const z = zoomAt(FIT, 2, at, BASE);
    expect(z.scale).toBe(2);
    // That point of the picture, (100, 350) less its center (200, 400), is drawn at center + offset + 2 × it.
    expect(200 + z.x + 2 * (100 - 200)).toBeCloseTo(at.x);
    expect(400 + z.y + 2 * (350 - 400)).toBeCloseTo(at.y);
  });

  it("keeps the scale between whole and MAX_SCALE", () => {
    expect(zoomAt(FIT, 0.2, { x: 0, y: 0 }, BASE).scale).toBe(1);
    expect(zoomAt(FIT, 40, { x: 0, y: 0 }, BASE).scale).toBe(MAX_SCALE);
  });

  it("a pinch scales by how far the fingers spread, around the point between them", () => {
    const mid = { x: 200, y: 400 };
    const z = pinch(FIT, mid, 100, mid, 300, BASE);
    expect(z).toEqual({ scale: 3, x: 0, y: 0 });
    // The fingers moved together 40px right as they spread: the picture goes with them.
    expect(pinch(FIT, mid, 100, { x: 240, y: 400 }, 200, BASE)).toEqual({ scale: 2, x: 40, y: 0 });
  });

  it("is kept on the screen: centered where it fits, its edges never inside the view where it does not", () => {
    expect(clamp({ scale: 1, x: 80, y: -30 }, BASE, VIEW)).toEqual(FIT);
    // 2×: 600 wide on a 400 wide screen moves at most 100 either way; 400 high on 800 stays centered.
    expect(clamp({ scale: 2, x: 500, y: 90 }, BASE, VIEW)).toEqual({ scale: 2, x: 100, y: 0 });
    expect(clamp({ scale: 2, x: -500, y: 0 }, BASE, VIEW)).toEqual({ scale: 2, x: -100, y: 0 });
  });

  it("a double tap goes in at the tap, and the next one back to whole", () => {
    const z = toggleAt(FIT, { x: 300, y: 400 }, BASE, VIEW);
    expect(z.scale).toBeGreaterThan(1);
    expect(z.x).toBeLessThan(0);
    expect(toggleAt(z, { x: 300, y: 400 }, BASE, VIEW)).toEqual(FIT);
  });

  it("finds the laid-out box back from the drawn one", () => {
    const z = { scale: 2, x: 40, y: -20 };
    const drawn = { left: 200 + 40 - 300, top: 400 - 20 - 200, width: 600, height: 400 };
    expect(laidOut(drawn, z)).toEqual(BASE);
  });
});

/** The rectangles the viewer measures: happy-dom lays nothing out, so the picture's follows its transform. */
function layOut() {
  const image = screen.getByTestId("avatar-viewer-image"), area = screen.getByTestId("avatar-viewer-backdrop");
  area.getBoundingClientRect = () => DOMRect.fromRect({ x: VIEW.left, y: VIEW.top, width: VIEW.width, height: VIEW.height });
  image.getBoundingClientRect = () => {
    const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([\d.e]+)\)/.exec(image.style.transform);
    const [x, y, s] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 1];
    const cx = BASE.left + BASE.width / 2 + x, cy = BASE.top + BASE.height / 2 + y;
    return DOMRect.fromRect({ x: cx - (BASE.width * s) / 2, y: cy - (BASE.height * s) / 2, width: BASE.width * s, height: BASE.height * s });
  };
  return { image, area };
}

const touch = (id: number, x: number, y: number) => ({ pointerId: id, pointerType: "touch", clientX: x, clientY: y, isPrimary: id === 1 });
const scale = () => Number(screen.getByTestId("avatar-viewer-image").dataset.zoom);

describe("the picture viewer on a touch screen", () => {
  it("does not let the browser zoom the page under it: a pinch is the picture's", () => {
    renderApp(<AvatarViewer picture src={PHOTO} name="ghost.png" onClose={() => {}} />);
    expect(screen.getByTestId("avatar-viewer").style.touchAction).toBe("none");
    expect(screen.getByTestId("avatar-viewer-backdrop").className).toContain("touch-none");
  });

  it("zooms the picture with two fingers, keeps it open when they lift off outside it, and pans it with one", () => {
    const onClose = vi.fn();
    renderApp(<AvatarViewer picture src={PHOTO} name="ghost.png" onClose={onClose} />);
    const { area } = layOut();
    expect(scale()).toBe(1);
    // Both fingers on the dark area around the picture, spreading from 100px apart to 300px.
    fireEvent.pointerDown(area, touch(1, 150, 150));
    fireEvent.pointerDown(area, touch(2, 250, 150));
    fireEvent.pointerMove(area, touch(1, 50, 150));
    fireEvent.pointerMove(area, touch(2, 350, 150));
    expect(scale()).toBe(3);
    fireEvent.pointerUp(area, touch(2, 350, 150));
    fireEvent.pointerUp(area, touch(1, 50, 150));
    expect(onClose).not.toHaveBeenCalled();
    expect(scale()).toBe(3);

    // One finger drags the zoomed picture; it stops where its edge meets the screen's.
    const before = screen.getByTestId("avatar-viewer-image").style.transform;
    fireEvent.pointerDown(area, touch(3, 200, 400));
    fireEvent.pointerMove(area, touch(3, 260, 400));
    fireEvent.pointerUp(area, touch(3, 260, 400));
    expect(screen.getByTestId("avatar-viewer-image").style.transform).not.toBe(before);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a double tap zooms in at the tap and the next one back to whole; a single tap outside still closes", () => {
    const onClose = vi.fn();
    renderApp(<AvatarViewer picture src={PHOTO} name="ghost.png" onClose={onClose} />);
    const { image, area } = layOut();
    const tap = (target: HTMLElement, x: number, y: number, at: number) => {
      fireEvent.pointerDown(target, { ...touch(10, x, y), timeStamp: at });
      fireEvent.pointerUp(target, { ...touch(10, x, y), timeStamp: at + 40 });
    };
    tap(image, 300, 400, 1000);
    tap(image, 302, 401, 1150);
    expect(scale()).toBeGreaterThan(1);
    tap(image, 300, 400, 3000);
    tap(image, 300, 400, 3150);
    expect(scale()).toBe(1);
    expect(onClose).not.toHaveBeenCalled();
    tap(area, 20, 20, 6000);
    expect(onClose).toHaveBeenCalledTimes(1);
    // The click a phone sends after that tap is the dismissal's (hooks/useDismiss.ts): taken here, not by the next test.
    fireEvent.click(document.body);
  });
});

describe("the picture viewer with a mouse and keys", () => {
  it("zooms on a double click and on + / -, and 0 puts it back whole", async () => {
    const { user } = renderApp(<AvatarOpener src={PHOTO} name="Alice"><span>A</span></AvatarOpener>);
    await user.click(screen.getByRole("button", { name: "View photo of Alice" }));
    const { image } = layOut();
    fireEvent.pointerDown(image, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 200, clientY: 400 });
    fireEvent.pointerUp(image, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 200, clientY: 400 });
    fireEvent.doubleClick(image, { clientX: 200, clientY: 400 });
    expect(scale()).toBeGreaterThan(1);
    await user.keyboard("0");
    expect(scale()).toBe(1);
    await user.keyboard("+");
    expect(scale()).toBe(1.5);
    await user.keyboard("-");
    expect(scale()).toBe(1);
    // Escape still closes it.
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("avatar-viewer")).not.toBeInTheDocument();
  });

  it("opens whole again after it was zoomed and closed", async () => {
    const { user } = renderApp(<AvatarOpener src={PHOTO} name="Alice"><span>A</span></AvatarOpener>);
    await user.click(screen.getByRole("button", { name: "View photo of Alice" }));
    layOut();
    await user.keyboard("+");
    expect(scale()).toBe(1.5);
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "View photo of Alice" }));
    expect(scale()).toBe(1);
  });
});
