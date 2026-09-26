/** The message without what was found in it, for the text shown above the card. */
export function cut(text: string, index: number, length: number): string {
  return (text.slice(0, index) + text.slice(index + length)).trim();
}

/** A link's own characters, without the sentence's closing punctuation or an unbalanced bracket around it. */
export function trimUriEnd(uri: string): string {
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  for (;;) {
    const last = uri[uri.length - 1];
    const opener = pairs[last];
    const count = (c: string) => uri.split(c).length - 1;
    if (/[.,;:!?'"*_>]/.test(last) || (opener && count(last) > count(opener))) uri = uri.slice(0, -1);
    else return uri;
  }
}
