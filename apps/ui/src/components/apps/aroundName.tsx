/** A stand-in for the contact's name while the line is translated: the name goes back in as an element of its own. */
export const NAME = "\u0001";

/**
 * "with Ana", "sharing a file with Ana" (the app panel), "Ana opened it here" (the app card): only the name is cut when
 * the line is too long, never the words around it, wherever the language puts them ("Ana とファイルを共有中" would lose
 * "sharing" after a long name). Unless the words alone fill the line (a 320 px phone in Portuguese): they stop 4ch
 * short of its end, cut, so a few letters of the name show. Its line is a one-line flex box that clips
 * (`flex min-w-0 overflow-hidden whitespace-nowrap`).
 */
export function aroundName(text: string, name: string, testId = "mini-app-with-name") {
  return text.split(NAME).flatMap((part, i) => [
    i > 0 && <bdi key={`name-${i}`} data-testid={testId} className="min-w-0 truncate">{name}</bdi>,
    part && <span key={i} className="shrink-0 max-w-[calc(100%-4ch)] overflow-hidden text-ellipsis whitespace-pre">{part}</span>,
  ]);
}
