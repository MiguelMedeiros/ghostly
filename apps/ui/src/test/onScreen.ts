import { vi } from "vitest";

/**
 * Everything observed is on screen, as a browser reports it for a short chat. happy-dom lays nothing out, so its
 * IntersectionObserver never says so, and a bubble that waits to be seen (a picture, a video's poster) waits for good.
 */
export function everythingOnScreen(): void {
  vi.stubGlobal("IntersectionObserver", class {
    constructor(private readonly fire: IntersectionObserverCallback) {}
    observe(target: Element) {
      queueMicrotask(() => this.fire([{ isIntersecting: true, target } as unknown as IntersectionObserverEntry], this as unknown as IntersectionObserver));
    }
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  });
}
