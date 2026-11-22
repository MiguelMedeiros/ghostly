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

/**
 * A line that wraps with a name in it ("Uninstall Chess!?", "Sent by Ana :)"): the name, an app's, a store's or a
 * contact's, keeps its own direction. Shared with the line's words, "Chess!" read "!Chess" in Arabic, and an Arabic
 * title's "!" went to its other end in English.
 */
export function withName(text: string, name: string) {
  return text.split(NAME).flatMap((part, i) => [i > 0 && <bdi key={`name-${i}`}>{name}</bdi>, part]);
}

/** The stand-ins of a line with two names (`withNames`): `NAME` for the first, this for the second. */
export const SECOND_NAME = "\u0002";

/** `withName` for a line with two names ("Ana wants to send report.pdf"): each goes back in as its own <bdi>. */
export function withNames(text: string, [first, second]: readonly [string, string]) {
  return text.split(NAME).flatMap((part, i) => [i > 0 && <bdi key={`name-${i}`}>{first}</bdi>,
    ...part.split(SECOND_NAME).flatMap((piece, j) => [j > 0 && <bdi key={`second-${i}-${j}`}>{second}</bdi>, piece])]);
}
