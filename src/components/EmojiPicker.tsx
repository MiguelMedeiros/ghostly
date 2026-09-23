import { useOutsideDismiss } from "../hooks/useDismiss";
import { useIsMobile } from "../hooks/useIsMobile";
import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useLockScreen } from "../contexts/LockScreenContext";
import data from "@emoji-mart/data";
import Picker from "@emoji-mart/react";

interface EmojiPickerProps {
  anchorRef: RefObject<HTMLButtonElement | null>;
  onSelect: (emoji: string) => void;
  onClose: () => void;
}

export function EmojiPicker({ anchorRef, onSelect, onClose }: EmojiPickerProps) {
  const isMobile = useIsMobile();
  const { isLocked } = useLockScreen();
  const containerRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>();
  useOutsideDismiss(containerRef, !isLocked, onClose, anchorRef);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const place = () => {
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth, height = viewport?.height ?? window.innerHeight;
      if (isMobile) {
        setPosition({left, right:"auto", width, bottom:Math.max(0, window.innerHeight-top-height), maxHeight:height*0.82,
          "--emoji-picker-height":`${height*0.52}px`} as CSSProperties);
        return;
      }
      const rect = anchor.getBoundingClientRect();
      const margin = 8, gap = 8, pickerWidth = Math.min(352, width-margin*2);
      const above = Math.max(0, rect.top-top-gap-margin);
      const below = Math.max(0, top+height-rect.bottom-gap-margin);
      const upward = above >= 435 || above >= below;
      const pickerHeight = Math.min(435, upward ? above : below);
      setPosition({position:"fixed", left:Math.max(left+margin, Math.min(rect.left, left+width-pickerWidth-margin)),
        top:upward ? rect.top-gap-pickerHeight : rect.bottom+gap, width:pickerWidth, height:pickerHeight,
        maxHeight:height-margin*2, overflow:"auto", zIndex:60, "--emoji-picker-height":`${pickerHeight}px`} as CSSProperties);
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(anchor);
    if (anchor.parentElement) observer.observe(anchor.parentElement);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.visualViewport?.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("scroll", place);
    };
  }, [anchorRef, isMobile]);

  // A portal avoids clipping by the composer and sidebar layout. Keep the same
  // lock protection as the app, which normally inherits inert from LockGate.
  if (isLocked) return null;
  return createPortal(
    <>
      {isMobile && <div className="sheet-backdrop" />}
      <div ref={containerRef} data-testid="emoji-popover" role="dialog" aria-label="Emoji picker"
        className={isMobile ? "sheet sheet-emoji" : "emoji-popover"}
        style={position ?? {visibility:"hidden"}}>
        <Picker
          key={isMobile ? "sheet" : "popover"}
          dynamicWidth
          data={data}
          onEmojiSelect={(emoji: { native: string }) => onSelect(emoji.native)}
          theme="dark"
          previewPosition="none"
          skinTonePosition="search"
          maxFrequentRows={2}
          perLine={8}
        />
      </div>
    </>, document.body,
  );
}
