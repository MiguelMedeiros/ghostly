import { utf8Encode } from "@ghostly/core";

/** The statement file as Windows tools also save it: after a byte order mark (Notepad's "UTF-8 with BOM", Windows
 * PowerShell's Out-File -Encoding utf8), as UTF-16 LE (Windows PowerShell's `>`) or as UTF-16 BE (Notepad's "UTF-16
 * BE"), each with or without a final newline. Never accepted, as a contact's app would not accept it either: only
 * recognised, to say what to change. */
export function windowsStatementFiles(text: string): Uint8Array[] {
  const utf16 = (s: string, le: boolean) => {
    const bytes = new Uint8Array(2 + 2 * s.length);
    bytes.set(le ? [0xff, 0xfe] : [0xfe, 0xff]);
    for (let i = 0; i < s.length; i++) {
      const lo = s.charCodeAt(i) & 0xff, hi = s.charCodeAt(i) >> 8;
      bytes.set(le ? [lo, hi] : [hi, lo], 2 + 2 * i);
    }
    return bytes;
  };
  return ["", "\n", "\r\n"].flatMap(end => {
    const file = `${text}${end}`;
    return [new Uint8Array([0xef, 0xbb, 0xbf, ...utf8Encode(file)]), utf16(file, true), utf16(file, false)];
  });
}
