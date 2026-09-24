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
```

After `npm run build`, restart a running dev server: reader routes are static
(`dynamicParams = false`) and new ones 404 until it restarts.

## Where things live

| Path | What |
|---|---|
| `app/` | Routes. English at the root, Brazilian Portuguese under `app/pt-br/` (thin wrappers around the same page components). |
| `components/home/` | Homepage: the hero, the four story chapters, the product section (one phone beside each window), your space, the wallet deck, the architecture stack and the finale with its download panel. |
| `components/story/` | The film's machinery. `Act` pins one full-bleed backdrop behind its chapters and keeps one Boo and one Casper in it; `SceneFrame` is a chapter (full-bleed stage, floating copy panel, step mapping); `poses.ts` is the blocking table (actors, camera, focal point per chapter, landscape and portrait); `Statement` is the sentence between the acts. |
| `components/dev/` | `/developers`: vocabulary, composition board, negotiation demo, path, availability table. |
| `components/catalog/`, `components/reader/`, `components/roadmap/` | Catalog, WISP reader, roadmap. |
| `components/ghost/Ghost.tsx` | Boo and Casper. `components/site/GhostPet.tsx` is the original pointer ghost, kept as it was. |
| `content/*.ts` | All copy, one object per locale. A missing translation is a type error. |
| `lib/wisps.ts` | The catalog model, built from `docs/wisps/numbering.json` and the documents. |
| `lib/wisp-editorial.ts` | Per-WISP benefit line, availability and optional video metadata. |
| `lib/composition.ts` | Blocks and presets of the composition board. |
| `content/videos/` | The video lesson template and an example script. |
| `scripts/capture/` | Playwright specs that re-shoot the app screenshots (`public/screenshots/current/`) from a built web app; see its README. |

## The story spine

Two acts, one continuous take each. Every chapter reads its coordinates from
`components/story/poses.ts` (stage units: 1440×900 landscape, 390×844 portrait),
so the exit pose of one chapter is the entry pose of the next by construction.
Inside a chapter, beats are placed with `useStep(p, step, n, [from, to], [a, b])`
from `components/home/stage.tsx`: a range inside one step, in step units, so
copy and picture stay in sync when a step's text changes. A chapter's picture
and copy fade in over p 0–.04 and out over p .90–.94, so the glide between two
chapters happens on the bare backdrop (`seams={false}` keeps them for a chapter
outside an act). The copy sits on a full-height wash, never a boxed panel. With
reduced motion, or without scripts, the same components render an illustrated
article — one still per step (`stills` on each scene) — and the act backdrop is
not drawn; the layout script in `app/layout.tsx` flags `html.calm` and
`html[data-orient]` before hydration so CSS carries that layout at first paint.

Touch devices (`(pointer: coarse)`) and viewports up to 860px do not get the
pinned, scroll-scrubbed film: momentum scrolling fights it. `useCards()` in
`components/home/stage.tsx` switches them to cards — the same article shape as
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

## Availability, checked against code

Four levels, separate from a document's Draft status:

- **released** — in the public release (`lib/release.ts`, built from `main`);
- **development** — merged on `dev`, going to the next release;
- **building** — work in progress, not merged;
- **planned** / **research**.

Before changing a level, check the code of both branches. Copy that names a
limit (sizes, windows, clients) must match the constants in the source.

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
