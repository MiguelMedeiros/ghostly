// What one QR code holds at level L (version 40), in the mode qrcode.react picks for the whole text: digits only,
// the alphanumeric set (an upper-cased invoice), or else its UTF-8 bytes. Past it, QRCodeSVG throws "Data too long".
const NUMERIC = /^[0-9]*$/;
const ALPHANUMERIC = /^[A-Z0-9 $%*+./:-]*$/;

/** Whether `text` fits one QR code at level L, so a QR of it can be drawn without throwing. */
export function qrFits(text: string): boolean {
  if (NUMERIC.test(text)) return text.length <= 7089;
  if (ALPHANUMERIC.test(text)) return text.length <= 4296;
  return new TextEncoder().encode(text).length <= 2953;
}
