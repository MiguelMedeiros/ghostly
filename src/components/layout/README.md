# Layout primitives

The pages beside the chat list (Wallet, Identities, Services, Settings, Profile) live in a column whose width
depends on the window **and** on how wide the chat list is dragged: on a desktop it can be as narrow as a
phone (the sidebar always leaves it at least 320px). So these pages never ask how wide the *window* is
(`sm:`, `max-md:`); they size themselves from the space they get. Use these instead of ad-hoc flex rows,
and a new card or panel holds together at every width for free.

| Primitive | Use it for |
| --- | --- |
| `Page` (`title`, `trailing`, `width`, `testId`) | A whole right-column page: header with Back, title and `trailing` controls (these wrap under the title when they do not fit), and a scrolling body that is a size container named `page`, so `@sm/page:` / `@md/page:` variants work anywhere inside. |
| `Section` (`title`) | A titled card of rows. |
| `Row` (`label`, `hint`, `value`, `leading`, children) | One option: text on the left, `value` (a balance, a size) and controls (children) on the right. When they do not fit beside at least 12rem of text (8rem without a hint), they wrap **under** the text, aligned with it. Buttons wrap among themselves. Text never collapses into a one-letter column. |
| `Block` | Anything in a section that is not a label/control pair: a form, a list, a paragraph. |
| `ButtonGroup` (`fill`) | Buttons side by side that wrap. `fill` makes them share the line equally. |
| `InputGroup` (`as="form"`) | A field and its button(s) on one line: the field keeps 12rem, then the buttons go under it. |
| `FieldGrid` (`min`, `max`) | Several fields in columns of at least `min` (12rem), at most `max` (2), one column when narrow. |
| `Truncate` | A URL or host on one line with an ellipsis; the whole value is in the tooltip. |

`wallet/ui.tsx` re-exports `Section`, `Row` and `Block`, and keeps the controls (`Button`, `Switch`,
`Segmented` — `compact` for a header —, `Amount`, `Address`, `input`).

Rules of thumb:

- A flex child that holds text gets `min-w-0`; amounts, buttons and badges get `shrink-0` /
  `whitespace-nowrap` (`Button` and `Row`'s `value` already do).
- Long URLs: `Truncate`. Addresses, keys, invoices: `break-all` in a `code` block, nowhere else.
- Touch targets are at least 40px (`Button` is `min-h-10`, icon buttons `w-10 h-10`, `Switch` has a
  larger invisible hit area).
- `e2e/web/responsive.spec.ts` visits every page at 1440, 1100, 900, 768 and 390px and fails on
  sideways overflow, a control past the page's edge, or text squeezed into a sliver. Add a new panel's
  states there.
