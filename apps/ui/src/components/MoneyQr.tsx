import { memo } from "react";
import { QRCodeSVG } from "qrcode.react";

/**
 * The QR code of money in a chat. Its card draws again on every engine state (a file moving sends up to 20 a second),
 * and QRCodeSVG writes its whole SVG path again on each draw: drawn again only when the money it holds changes.
 */
export const MoneyQr = memo(function MoneyQr({ value }: { value: string }) {
  return <QRCodeSVG value={value} size={184} bgColor="#ffffff" fgColor="#0b0f1a" level="L" className="block max-w-full h-auto" />;
});
