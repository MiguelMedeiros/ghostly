import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/**
 * A button taken out of the page while it has the focus (Download, once the file is asked for) leaves the focus on
 * the page itself, and the next Tab starts from the top. The focus goes to `ref`'s element instead, so Tab goes on
 * from there. Only when the focus was on something inside it that is gone, and is on nothing now. The element is a
 * stop of its own only while it holds that focus, unless it already was one.
 */
export function useFocusKept(ref: RefObject<HTMLElement | null>): void {
  /** What has the focus inside the element. */
  const held = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const onIn = (event: FocusEvent) => { held.current = event.target instanceof HTMLElement && event.target !== root ? event.target : null; };
    const onOut = (event: FocusEvent) => {
      const target = event.target;
      if (event.relatedTarget) held.current = null;
      // To nothing: the person's own move if it is still in the page. One taken out is seen after the render.
      else setTimeout(() => { if (held.current === target && (target as Node).isConnected && document.activeElement !== target) held.current = null; });
    };
    root.addEventListener("focusin", onIn);
    root.addEventListener("focusout", onOut);
    return () => { root.removeEventListener("focusin", onIn); root.removeEventListener("focusout", onOut); };
  }, [ref]);
  // After every render: what took the button out is this component's own render.
  useLayoutEffect(() => {
    const root = ref.current, was = held.current;
    if (!root || !was || was.isConnected) return;
    held.current = null;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    if (!root.hasAttribute("tabindex")) {
      root.tabIndex = -1;
      root.addEventListener("blur", () => root.removeAttribute("tabindex"), { once: true });
    }
    root.focus({ preventScroll: true });
  });
}
