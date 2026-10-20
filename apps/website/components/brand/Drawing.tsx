import { draw, tile } from "@/lib/brand/logo.mjs";

type Shape = { d: string; fill: string; transform?: string; evenOdd?: boolean; opacity?: number };
export type DrawingData = { id: string; viewBox: number[]; shapes: Shape[] };
export type Variant = "lockup" | "icon" | "wordmark";

/**
 * A logo drawing from lib/brand/logo.mjs, as React SVG: the same shapes the press kit writes to its .svg files.
 * Decorative by default; with `label` it is an image with that name.
 */
export function Drawing({ drawing, label, className, style }: { drawing: DrawingData; label?: string; className?: string; style?: React.CSSProperties }) {
  return (
    <svg
      viewBox={drawing.viewBox.join(" ")}
      className={className}
      style={style}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {drawing.shapes.map((s, i) => (
        <path key={i} d={s.d} fill={s.fill} fillRule={s.evenOdd ? "evenodd" : undefined} opacity={s.opacity} transform={s.transform} />
      ))}
    </svg>
  );
}

export function Logo({ variant, fill, label, className, style }: { variant: Variant | "tile"; fill?: string; label?: string; className?: string; style?: React.CSSProperties }) {
  const drawing = (variant === "tile" ? tile() : draw(variant, fill ?? "currentColor")) as DrawingData;
  return <Drawing drawing={drawing} label={label} className={className} style={style} />;
}
