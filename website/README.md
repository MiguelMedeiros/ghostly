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
| `components/home/` | Homepage scenes. Each scroll scene is a `SceneFrame` (`components/story/`) with an SVG stage driven by scroll progress. |
| `components/dev/` | `/developers`: vocabulary, composition board, negotiation demo, path, availability table. |
| `components/catalog/`, `components/reader/`, `components/roadmap/` | Catalog, WISP reader, roadmap. |
| `components/ghost/Ghost.tsx` | Boo and Casper. `components/site/GhostPet.tsx` is the original pointer ghost, kept as it was. |
| `content/*.ts` | All copy, one object per locale. A missing translation is a type error. |
| `lib/wisps.ts` | The catalog model, built from `docs/wisps/numbering.json` and the documents. |
| `lib/wisp-editorial.ts` | Per-WISP benefit line, availability and optional video metadata. |
| `lib/composition.ts` | Blocks and presets of the composition board. |
| `content/videos/` | The video lesson template and an example script. |

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
