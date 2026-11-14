import { qrModules, qrPath } from "@/lib/qr";

/** The quiet zone a reader needs around the symbol, in modules. */
const MARGIN = 4;

/**
 * A QR code for `text`, drawn on the server (lib/qr.ts): dark modules on white,
 * whatever the theme, since a phone's camera reads that best.
 */
export function QrCode({ text, label, className }: { text: string; label: string; className?: string }) {
  const modules = qrModules(text);
  const n = modules.length + MARGIN * 2;
  return (
    <svg className={className} viewBox={`0 0 ${n} ${n}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={n} height={n} rx={1.5} fill="#fff" />
      <path d={qrPath(modules, MARGIN)} fill="#000" />
    </svg>
  );
}
