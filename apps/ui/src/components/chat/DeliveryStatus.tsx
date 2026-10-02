import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { deliveryShape, useDeliveryWords, type DeliveryShape, type DhtOnlyBy } from "../../lib/delivery";
import type { ChatMessage } from "../../lib/types";

/**
 * The mark itself. `cutout` is the colour of what it sits on, for the "!" cut out of the red circle; `ink` its
 * colour classes when the caller has its own (the dark chip over a picture).
 */
export function DeliveryIcon({ shape, cutout = "var(--color-sent-bg)", className = "" }: { shape: DeliveryShape; cutout?: string; className?: string }) {
  if (shape === "failed") {
    return (
      <svg width="13" height="13" viewBox="0 0 11 11" fill="none" aria-hidden="true" className={`shrink-0 ${className}`}>
        <circle cx="5.5" cy="5.5" r="5" fill="currentColor" />
        <path d="M5.5 2.6v3.3M5.5 7.6v.4" stroke={cutout} strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }
  if (shape === "pending") {
    return (
      <svg width="12" height="12" viewBox="0 0 11 11" fill="none" aria-hidden="true" className={`shrink-0 ${className}`}>
        <circle cx="5.5" cy="5.5" r="4.6" stroke="currentColor" strokeWidth="1.2" />
        <path d="M5.5 3v2.7l1.7 1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg width="16" height="11" viewBox="0 0 16 11" fill="none" aria-hidden="true" className={`shrink-0 ${className}`}>
      <path d="M11.07 0.66L4.98 6.75L2.91 4.68L1.5 6.09L4.98 9.57L12.48 2.07L11.07 0.66Z" fill="currentColor" />
      {shape === "delivered" && <path d="M14.07 0.66L7.98 6.75L7.05 5.82L5.64 7.23L7.98 9.57L15.48 2.07L14.07 0.66Z" fill="currentColor" />}
    </svg>
  );
}

/** A finger held on the mark this long shows its line, as long as a long press on the message opens its details. */
const PRESS_MS = 500;
/** How long a line shown by a tap or a press stays up. */
const TIP_MS = 2500;

/**
 * The mark beside the time of a message of mine: nothing else is said in the bubble. Hovered, focused, tapped or
 * held, it says in one line what it means; the details panel (⋮ → Details) has the rest. A message that was not
 * sent is a button: pressing the red mark sends it again.
 */
export function DeliveryStatus({ delivery, acked = false, onPicture = false, onRetry, live, group }: {
  delivery?: ChatMessage["delivery"];
  /** A waiting file in a DHT-only chat: it waits for a live connection, and who chose DHT only. */
  live?: DhtOnlyBy;
  acked?: boolean;
  /** A group's message: its line says a group has no receipts, where a chat's says none came yet. */
  group?: boolean;
  /** On the dark chip over a picture, dark in every theme. */
  onPicture?: boolean;
  /** Sends a message that was not sent again. */
  onRetry?: () => void;
}) {
  const words = useDeliveryWords();
  const state = delivery ?? (acked ? "delivered" : "sent");
  const shape = deliveryShape(delivery, acked);
  const [tip, setTip] = useState(false);
  const tipId = useId();
  const press = useRef<{ x: number; y: number; timer?: ReturnType<typeof setTimeout>; fired: boolean } | null>(null);
  const hide = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => { clearTimeout(hide.current); clearTimeout(press.current?.timer); }, []);

  const show = (linger: boolean) => {
    clearTimeout(hide.current);
    setTip(true);
    if (linger) hide.current = setTimeout(() => setTip(false), TIP_MS);
  };
  const ink = onPicture
    ? shape === "delivered" ? "text-[#53bdeb]" : shape === "failed" ? "text-[#ff9a8f]" : "text-[hsla(0,0%,100%,0.9)]"
    : shape === "delivered" ? "text-link" : shape === "failed" ? "text-danger-ink" : "text-text-primary/65";
  const failed = shape === "failed" && !!onRetry;

  const handlers = {
    // The message's own long press (its details) and swipe (a reply) start from here otherwise.
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      e.stopPropagation();
      if (e.pointerType === "mouse") return;
      clearTimeout(press.current?.timer);
      const held = { x: e.clientX, y: e.clientY, fired: false } as NonNullable<typeof press.current>;
      held.timer = setTimeout(() => { held.fired = true; show(true); }, PRESS_MS);
      press.current = held;
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      const held = press.current;
      if (held && !held.fired && Math.hypot(e.clientX - held.x, e.clientY - held.y) > 10) { clearTimeout(held.timer); press.current = null; }
    },
    onPointerUp: () => { if (press.current && !press.current.fired) clearTimeout(press.current.timer); },
    onPointerCancel: () => { clearTimeout(press.current?.timer); press.current = null; },
    onPointerEnter: (e: ReactPointerEvent<HTMLElement>) => { if (e.pointerType === "mouse") show(false); },
    onPointerLeave: (e: ReactPointerEvent<HTMLElement>) => { if (e.pointerType === "mouse") setTip(false); },
    onContextMenu: (e: React.MouseEvent) => { if (press.current) e.preventDefault(); },
  };
  const common = {
    ...handlers,
    "data-testid": "message-delivery",
    // The engine's own state, exactly; a message from before delivery states says only whether it was acknowledged.
    "data-delivery": delivery ?? (acked ? "acked" : "unacked"),
    "aria-describedby": tip ? tipId : undefined,
    className: `relative inline-flex items-center ${ink} ${failed ? "cursor-pointer rounded-full focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-current before:absolute before:-inset-2 before:content-['']" : ""}`,
  };

  return (
    <span className="relative inline-flex">
      {failed ? (
        <button type="button" {...common} aria-label={words.retry}
          onFocus={() => show(false)} onBlur={() => setTip(false)}
          onClick={() => {
            // A press held long enough to read the line is not a request to send.
            const held = press.current?.fired;
            press.current = null;
            if (held) return;
            setTip(false);
            onRetry!();
          }}>
          <DeliveryIcon shape={shape} cutout={onPicture ? "#0b141a" : undefined} />
        </button>
      ) : (
        <span role="img" {...common} aria-label={words.label(state, live)}
          onClick={(e) => { e.stopPropagation(); if (press.current?.fired) { press.current = null; return; } press.current = null; show(true); }}>
          <DeliveryIcon shape={shape} cutout={onPicture ? "#0b141a" : undefined} />
        </span>
      )}
      {tip && (
        <span role="tooltip" id={tipId} data-testid="message-delivery-tip"
          className="absolute bottom-full end-0 mb-1.5 z-20 w-max max-w-[15rem] whitespace-normal rounded-md border border-border bg-surface-alt px-2 py-1 text-start text-[11.5px] leading-snug text-text-primary shadow-lg pointer-events-none animate-fade-in">
          {words.hint(state, live, group)}
        </span>
      )}
    </span>
  );
}
