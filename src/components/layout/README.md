# Layout primitives

The pages beside the chat list (Wallet, Identities, Services, Settings, Profile) live in a column whose width
depends on the window **and** on how wide the chat list is dragged: on a desktop it can be as narrow as a
phone (the sidebar always leaves it at least 320px). So these pages never ask how wide the *window* is
(`sm:`, `max-md:`); they size themselves from the space they get. Use these instead of ad-hoc flex rows,
and a new card or panel holds together at every width for free.

| Primitive | Use it for |
| --- | --- |
| `Page` (`title`, `trailing`, `width`, `testId`) | A whole right-column page: header with Back, title and `trailing` controls (these wrap under the title when they do not fit), and a scrolling body that is a size container named `page`, so `@sm/page:` / `@md/page:` variants work anywhere inside. |
| `PageAction` (`label`, `testId`, button props) | The page's primary action in `trailing`: an accent button with a plus and a short label, like New on Identities and Wallets. The page creates things there, not with an add card in its list. |
| `Section` (`title`) | A titled card of rows. |
| `Row` (`label`, `hint`, `value`, `leading`, children) | One option: text on the left, `value` (a balance, a size) and controls (children) on the right. When they do not fit beside at least 12rem of text (8rem without a hint), they wrap **under** the text, aligned with it. Buttons wrap among themselves. Text never collapses into a one-letter column. |
| `LinkRow` (`label`, `hint`, `value`, `leading`, `onClick`) | A row that opens another page: the whole line is a button, ending in a chevron. |
| `Block` | Anything in a section that is not a label/control pair: a form, a list, a paragraph. |
| `ButtonGroup` (`fill`) | Buttons side by side that wrap. `fill` makes them share the line equally. |
| `InputGroup` (`as="form"`) | A field and its button(s) on one line: the field keeps 12rem, then the buttons go under it. |
| `FieldGrid` (`min`, `max`) | Several fields in columns of at least `min` (12rem), at most `max` (2), one column when narrow. |
| `Truncate` | A URL or host on one line with an ellipsis; the whole value is in the tooltip. |

## Where Back goes

`Page`'s Back never walks the history (`src/lib/navigation.ts`, run by `useAppNavigation`):

| Level | What | Opened with | Back |
| --- | --- | --- | --- |
| home | `/`: the chat list, New and Join | `nav.home()` | — |
| conversation | `/chat/…`, `/group/…` | `nav.conversation(path)`: always on home | home |
| place | Wallet, Identities, Services, Settings, Profile | `nav.place(path)` (account bar, tab bar): on home, or over the chat open now; places replace each other | home |
| sub-page | a page opened from inside another (Settings → Profile, Profile → Wallets, a chat's "Manage identities") | `nav.open(path)`: pushed on its parent; a page already below is gone back to | its parent |

Going home is going *back* (each entry records what is under it), so the browser's Back from a place is home
and from home it leaves the app's pages. A deep link gets home put under it. On a phone the header's Back
shows only on a sub-page: the tab bar is the way home. Never `navigate(-1)` or push `/` from a page.

`wallet/ui.tsx` re-exports `Section`, `Row` and `Block`, and keeps the controls (`Button`, `Switch`,
`Segmented` — `compact` for a header —, `Amount`, `Address`, `input`).

A choice among several options is `Select` (`ui/Select.tsx`; `fit` in a `Row`, `size="sm"` in a chat bubble), never a
native `<select>` (lint refuses one): options take a `description` (a second, dimmer line) and an `icon`, and the list
clears dialogs and fits a phone. Tests drive it with `choose()` / `optionsOf()` (`src/test/select.ts`,
`e2e/support/select.ts`), and read its value from `data-value`.

Rules of thumb:

- A flex child that holds text gets `min-w-0`; amounts, buttons and badges get `shrink-0` /
  `whitespace-nowrap` (`Button` and `Row`'s `value` already do).
- Long URLs: `Truncate`. Addresses, keys, invoices: `break-all` in a `code` block, nowhere else.
- Touch targets are at least 40px (`Button` is `min-h-10`, icon buttons `w-10 h-10`, `Switch` has a
  larger invisible hit area).
- `e2e/web/responsive.spec.ts` visits every page at 1440, 1100, 900, 768 and 390px and fails on
  sideways overflow, a control past the page's edge, or text squeezed into a sliver. Add a new panel's
  states there.
