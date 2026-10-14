type Segmenter = { segment(text: string): Iterable<{ segment: string }> };
let segmenter: Segmenter | null | undefined;

/**
 * The first character of a name as a person sees it, in upper case: what a round avatar without a picture shows.
 * An emoji, a flag or a letter with its marks is several UTF-16 units; the first unit alone drew "�".
 */
export function initial(name: string): string {
  if (segmenter === undefined) {
    const Ctor = (globalThis as { Intl?: { Segmenter?: new (locale?: string, options?: { granularity: string }) => Segmenter } }).Intl?.Segmenter;
    segmenter = Ctor ? new Ctor(undefined, { granularity: "grapheme" }) : null;
  }
  let first = "";
  // Where the browser cannot tell characters apart, the first code point: still a whole emoji, never half of one.
  if (segmenter) for (const { segment } of segmenter.segment(name)) { first = segment; break; }
  else first = Array.from(name)[0] ?? "";
  return first.toUpperCase();
}
