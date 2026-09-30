# Message text parser

How a message's text shows. The text is sent exactly as typed; everything here happens on display, and nothing
is ever rendered as HTML: segments carry plain text and `apps/ui/src/components/rich/` builds the elements.

## What people can write

| Written | Shows | Notes |
| --- | --- | --- |
| `*bold*` | **bold** | WhatsApp's convention. `**bold**` works too, for people used to Markdown. |
| `_italic_` | _italic_ | `__italic__` too. |
| `~~strike~~` | ~~strike~~ | A single `~` is text ("~5 min"). |
| `` `code` `` | `code` | A run of N backticks closes at the next run of N; nothing inside is read. |
| `\|\|spoiler\|\|` | a covered stretch | Tap, click, Enter or Space shows it. Screen readers hear "Hidden text" until then; the chat list shows `▒▒▒`. |
| ```` ```ts ```` … ```` ``` ```` | a code block | The language after the fence is optional; highlighting loads on first use. A fence that never closes is text. |
| a message that is JSON | pretty-printed | Re-indented as written, not parsed and printed again. |
| 80+ base64/hex characters | one line, Show all, Copy | Keys, signatures, tokens. |
| `2026-09-25T14:00Z`, `at 14:00 UTC`, `3pm GMT+2` | the reader's local time on hover or tap | Only with a zone; see `time.ts` for the zones read. |
| `https://…` | a link | `linkEnd` leaves trailing punctuation and unopened brackets out. |
| `[text](https://…)` | "text" as a link | http(s) only: `[a](javascript:…)` stays text. The host and the whole address show on hover; a long press gets the browser's own menu. Text that reads as another host than the link's (or holds an invisible or direction character) shows the address instead (`labelMisleads`, `mdlink.ts`). The text is read as a browser reads a host ("ghostly。tools" is "ghostly.tools"); file names ("report.pdf", "docs/CHAT.md") are not hosts. The text takes formatting but no code: backticks pair first. |
| `- item`, `* item`, `• item` | a bullet list | At the start of a line, with a space after the marker. A 2-space (or tab) indent puts an item under the one before, one level deep. An indented line goes on with its item; an unindented one ends the list, and one blank line between items does not. Wrapped lines hang beside the marker. |
| `1. item`, `2) item` | a numbered list | The author's numbers and `.` or `)` are kept, never redone. "1.5 kg" is not an item: the marker needs the space. |
| `> text` | a quote: a bar at the start side, softer text | Lines starting with `> ` (or `>` alone, an empty line of it). What it holds is read again: lists and headings work inside; a quote inside a quote does not. Not the reply quote (#347). |
| `# `, `## `, `### ` | a bold line, a little larger | Headings without heading semantics or big margins: a bubble is not a document, and every bubble's headings in the page's outline would bury the chat's own. `#general` and `#360` stay text. |
| `@Name` picked in a group's composer | the member's name now, mine stronger | Not a pattern: the message's mentions give the places (`mentions.ts` marks them before parsing for the `member-mention` detector). |

Lists, quotes and headings are read line by line outside fenced code, so nothing inside code is one. The blank line
and line break around one are its room, which a small margin gives. A message with none of them is one paragraph,
line breaks kept, as before. The chat list keeps a list's markers ("•" for any bullet, the author's numbers).

Markers pair within one line, and only at word edges: a marker opens after a space, punctuation or the start and
before a non-space, and closes the other way round. So `snake_case_name`, `2*3*4` and `__init__.py` stay text, and
so does anything inside a link or code.

## Adding a kind of atom (the other parser cards)

1. Write a `Detector` (`types.ts`) in its own file: a global pattern, `accept` turning a match into data (or null),
   and optionally `plain` for the chat list.
2. Add it to `DETECTORS` in `detectors.ts`. Order breaks ties between matches starting at the same place.
3. For a look of its own, add a component to `VIEWS` in `apps/ui/src/components/rich/views.ts`, keyed by the kind. Without
   one the atom shows as the text it matched.

Keep patterns linear (no nested quantifiers); `apps/ui/src/test/parse/tokenizer.test.ts` runs 1 MB inputs against every
registered detector.
