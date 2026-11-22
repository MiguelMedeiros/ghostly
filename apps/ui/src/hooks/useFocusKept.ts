import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/**
 * A button taken out of the page while it has the focus (Download, once the file is asked for) leaves the focus on
 * the page itself, and the next Tab starts from the top. The focus goes to `ref`'s element instead, so Tab goes on
 * from there. Only when the focus was on something inside it that is gone, and is on nothing now. The element is a
 * stop of its own only while it holds that focus, unless it already was one. `next`: what is left inside to take it
 * first (a row's ⋮ once its Move to goes), when it is still in the page; `false` when another part of the screen
 * places the focus for what took the button out this time.
 */
export function useFocusKept(ref: RefObject<HTMLElement | null>, next?: () => HTMLElement | null | false): void {
  /** What has the focus inside the element. */
  const held = useRef<HTMLElement | null>(null);
  /** The element listened to. `ref`'s can come after the first render (a payment said in words until the wallet is there). */
  const listened = useRef<{ root: HTMLElement; stop: () => void } | null>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    if (listened.current?.root === root) return;
    listened.current?.stop();
    listened.current = null;
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
    listened.current = { root, stop: () => { root.removeEventListener("focusin", onIn); root.removeEventListener("focusout", onOut); } };
  });
  useEffect(() => () => { listened.current?.stop(); listened.current = null; }, []);
  // After every render: what took the button out is this component's own render.
  useLayoutEffect(() => {
    const root = ref.current, was = held.current;
    if (!root || !was || was.isConnected) return;
    held.current = null;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const left = next?.();
    if (left === false) return;
    if (left?.isConnected) { left.focus({ preventScroll: true }); return; }
    if (!root.hasAttribute("tabindex")) {
      root.tabIndex = -1;
      root.addEventListener("blur", () => root.removeAttribute("tabindex"), { once: true });
    }
    root.focus({ preventScroll: true });
  });
}
