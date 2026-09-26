# Message text parser

How a message's text shows. The text is sent exactly as typed; everything here happens on display, and nothing
is ever rendered as HTML: segments carry plain text and `src/components/rich/` builds the elements.

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

Markers pair within one line, and only at word edges: a marker opens after a space, punctuation or the start and
before a non-space, and closes the other way round. So `snake_case_name`, `2*3*4` and `__init__.py` stay text, and
so does anything inside a link or code.

## Adding a kind of atom (the other parser cards)

1. Write a `Detector` (`types.ts`) in its own file: a global pattern, `accept` turning a match into data (or null),
   and optionally `plain` for the chat list.
2. Add it to `DETECTORS` in `detectors.ts`. Order breaks ties between matches starting at the same place.
3. For a look of its own, add a component to `VIEWS` in `src/components/rich/views.ts`, keyed by the kind. Without
   one the atom shows as the text it matched.

Keep patterns linear (no nested quantifiers); `src/test/parse/tokenizer.test.ts` runs 1 MB inputs against every
registered detector.
