/**
 * The words a page shows for an outside link: the host it goes to, as the browser parses it (punycode, lower case),
 * then its path. Never the text as written, where a look-alike slash or dot (`github.com∕x.attacker.dev`) can spell
 * another host than the one the link opens.
 */
export function linkText(href: string): string {
  let url: URL;
  try { url = new URL(href); } catch { return href; }
  const rest = `${url.pathname}${url.search}${url.hash}`;
  return `${url.host}${rest === "/" ? "" : rest}`;
}
