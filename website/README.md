# ghostly.tools

The Ghostly website: the story for people (`/`), the story for developers
(`/developers`), the WISP catalog and reader, the roadmap, and the existing CLI,
protocol docs and privacy pages. Next.js (see `AGENTS.md`: this version differs
from older ones), motion for scroll scenes, no WebGL.

```bash
npm ci
npm run dev -- -p 4330     # sync:references runs on build, run it by hand for dev
npm run sync:references
npm run build && npm run lint
npm run test:e2e           # the browser checks, against a build
npm run capture            # re-shoot every app screenshot (scripts/capture/README.md)
```

`npm run lint` is ESLint, then `scripts/check-dashes.mjs`: no em or en dash in the site's copy
(`app/`, `components/`, `content/`, `lib/`, `scripts/`) or in the repository documents it renders
(below). Use a period, a comma, a colon or parentheses, and a hyphen or "to" in a range.

After `npm run build`, restart a running dev server: reader routes are static
(`dynamicParams = false`) and new ones 404 until it restarts.

## Where things live

| Path | What |
|---|---|
| `app/` | Routes. English at the root, Brazilian Portuguese under `app/pt-br/` (thin wrappers around the same page components). |
| `components/home/` | Homepage: the hero and four story chapters in two acts (invite, DHT; agree, alive), the app screenshots, your space with the wallet deck, the open layer stack and the finale with its download panel. |
| `components/story/` | The film's machinery. `Act` pins one full-bleed backdrop behind its chapters and keeps one Boo and one Casper in it; `SceneFrame` is a chapter (full-bleed stage, floating copy panel, step mapping); `poses.ts` is the blocking table (actors, camera, focal point per chapter, landscape and portrait); `Statement` is the sentence between the acts. |
| `components/dev/` | `/developers`: protocol loop, composition board, negotiation demo, path, availability table. |
| `components/catalog/`, `components/reader/`, `components/roadmap/` | Catalog (with the six-word glossary at `#glossary`, linked from the reader), WISP reader, roadmap. |
| `components/ghost/Ghost.tsx` | Boo and Casper. `components/site/GhostPet.tsx` is the original pointer ghost, kept as it was. |
| `content/*.ts` | All copy, one object per locale. A missing translation is a type error. |
| `lib/wisps.ts` | The catalog model, built from `docs/wisps/numbering.json` and the documents. |
| `lib/wisp-editorial.ts` | Per-WISP benefit line, availability and optional video metadata. |
| `lib/composition.ts` | Blocks and presets of the composition board. |
| `content/videos/` | The video lesson template and an example script. |
| `e2e/` | The browser checks (`npm run test:e2e` against a build). CI runs them in four shards of about equal time: `e2e/shard.mjs` splits the tests by `e2e/durations.json`. After adding a spec or making one slower, record the times again (the command is at the top of `shard.mjs`); a stale file only unbalances the shards, it never skips a test. |
| `scripts/capture/` | The app screenshots (`public/screenshots/current/`): `npm run capture` re-shoots all of them from a fresh build of `dev`, with funded test wallets from the shared e2e environment; see its README. |

## The story spine

Two acts, one continuous take each. Every chapter reads its coordinates from
`components/story/poses.ts` (stage units: 1440×900 landscape, 390×844 portrait),
so the exit pose of one chapter is the entry pose of the next by construction.
Inside a chapter, beats are placed with `useStep(p, step, n, [from, to], [a, b])`
from `components/home/stage.tsx`: a range inside one step, in step units, so
copy and picture stay in sync when a step's text changes. A chapter's picture
and copy fade in over p 0 to .04 and out over p .90 to .94, so the glide between two
chapters happens on the bare backdrop (`seams={false}` keeps them for a chapter
outside an act). The copy sits on a full-height wash, never a boxed panel. With
reduced motion, or without scripts, the same components render an illustrated
article, one still per step (`stills` on each scene), and the act backdrop is
not drawn; the layout script in `app/layout.tsx` flags `html.calm` and
`html[data-orient]` before hydration so CSS carries that layout at first paint.

Touch devices (`(pointer: coarse)`) and viewports up to 860px do not get the
pinned, scroll-scrubbed film: momentum scrolling fights it. `useCards()` in
`components/home/stage.tsx` switches them to cards: the same article shape as
reduced motion, but each step's frame plays its beat once as it scrolls into
view (`StaticFigure` tweens the scene's `p` from the step's start to its still).
The layout script also flags `html[data-touch]` so the CSS carries that shape
before hydration. `components/story/StoryRail.tsx` is the thin progress rail
under the nav: one mark per chapter, filling with the scroll.

Two motion traps worth knowing: motion scales SVG groups about their own
bounding box, so any scaled `motion.g` positioned by its top-left spreads
`VIEW_BOX_ORIGIN` into its style; and `useTransform(scroll, [range], [out])`
becomes a native scroll-linked animation fixed at mount, so a range that depends
on state (orientation, locale) must use the function form.

Debug helpers, not shipped: `.shots.mjs` (screenshots of any page at scroll
fractions), `.spine.mjs` (each chapter at chosen sub-progress values),
`.modes2.mjs` (reduced motion and no-JS renders with a console-error check).
They need the dev server on :4330 and Chrome.

## Repository docs the site renders

`npm run sync:references` (also run by `npm run build`) copies these into
`public/reference/` (not committed) and indexes them in `lib/reference-index.json`;
the reader shows each one under `/developers/wisps/<slug>`:

- `docs/wisps/*.md`, except the forwarding stubs of renumbered WISPs and the
  `HANDOFF-CLAUDE*` / `QA-CLAUDE*` notes;
- `docs/PROTOCOL.md`, `docs/SDK.md`, `docs/USDT-INTEGRATION.md`, `docs/DHT-DELIVERY.md`;
- `CONTRIBUTING.md` and `SECURITY.md`.

It also writes `docs/wisps/NUMBERING.md` and the forwarding stubs,
`lib/wisp-numbering.json`, `lib/roadmap-candidates.json` (from
`docs/wisps/ADAPTER-ROADMAP.md`) and `lib/code-snippets.json`, the two excerpts
`/developers` quotes from `packages/core/src/invite.ts` and
`packages/core/src/pairedTransports.ts`. Other repository docs (`docs/TESTING.md`,
`docs/CLI.md`, ...) are not on the site.

A pull request that changes any of these inputs runs the Website jobs in CI
(`WEBSITE_INPUTS` in `scripts/ci-changes.mjs`); one that does not skips them.

## Availability, checked against code

Three levels (`lib/status.ts`), separate from a document's Draft status:

- **available**: what the app on `dev` does today;
- **planned** and **research**: only for what is not built.

Before changing a level, check the code. Copy that names a limit (sizes,
windows, clients) must match the constants in the source.

## Adding or renumbering a WISP

Edit `docs/wisps/numbering.json` and add the document; `npm run sync:references`
copies it, parses its header table (status, dependencies, implementation) and
writes `lib/reference-index.json`. The draft then appears in the catalog and the
reader with no other change; add an entry to `lib/wisp-editorial.ts` for its
plain-language benefit and verified availability. Counts on the site are always
computed. `notes-local/` and `HANDOFF-CLAUDE*` / `QA-CLAUDE*` files are never published.

## Docker

`docker compose build` builds from the repository root (`context: ..`) because
the site reads `docs/` and quotes `packages/core/src`; `Dockerfile.dockerignore`
keeps that context small.
