# Ghostly trailer: a ghost story

An 80 second narrated trailer that tells how two Ghostly apps find each other, as a story: Boo sends Casper an
invitation, leaves a sealed note in a crowd of strangers (the DHT), Casper's invitation knows where to look, they
agree on how to talk and step out of the crowd onto a direct line, and the notes fade. No technical words on screen;
the picture uses the website's pairing look (the app's ghost, the dotted mesh, ringed nodes).

The narration drives the clock: every motion is tied to a word the narrator says, and the picture declares where its
sounds are, so the mix places each one on the frame that moves.

| File | What it does |
|---|---|
| `script.json` | The lines: what the voice says (`say`), the captions (`show`), the silence before each (`gap`), the music part (`act`). A `|` in a line is a pause. The voice (George, an ElevenLabs premade narrator) and its settings. |
| `voice.mjs` | Speaks each line with character timestamps, opens a pause at every `|` (cut in the quiet between phrases), writes `cache/voice/<id>.wav` and every word's time. Cached by request hash: a rerun bills only changed lines. |
| `timeline.mjs` | Lays the lines out after their gaps: `out/timeline.json` (lines, words, caption chunks, music parts, duration). |
| `music.mjs` | One ElevenLabs music cue per part (cold open, story, rise, title) and the trailer's own effects (crumble, whoosh, wind, blip, hit, pluck). Cached like the voice. |
| `film/` | The picture (Vite, React, SVG). `Film.tsx` holds the scenes, the camera and `SOUNDS` (where each effect lands); `world.ts` the seeded crowd, its mesh and the notes' routes. |
| `render.mjs` | Serves `film/`, seeks every frame in headless Chromium, encodes `out/<format>/picture.mp4`, and writes the picture's `sounds.json`. |
| `mix.mjs` | Voice, score, the picture's sounds (the app's own cues from `src/assets/sounds` plus the trailer's), the score under the voice, -14 LUFS, then `out/ghostly-trailer-<format>.mp4`. |
| `check.mjs` | The report: the voice over the score line by line, each sound's attack against its moment, where the picture moves, loudness (`out/<format>/sync.md`). |

`out/` and `cache/` are not in git.

## Render

From the repository root, after `npm ci`. The ElevenLabs key is read from the environment, never written anywhere:

```bash
( set -a; . ~/code/liquid-saga/.env.local; set +a; node media/ghost-trailer/voice.mjs && node media/ghost-trailer/timeline.mjs && node media/ghost-trailer/music.mjs )
```

```bash
lockf -k /tmp/ghostly-heavy.lock node media/ghost-trailer/render.mjs --format 16x9 --workers 4
```

```bash
node media/ghost-trailer/mix.mjs --format 16x9 && node media/ghost-trailer/check.mjs --format 16x9
```

A moment without rendering: `node media/ghost-trailer/render.mjs --stills 40,62` (or `--sheet` for 24 stills).
`npx vite --config media/ghost-trailer/vite.config.ts` serves the page on 5393; `?t=40` shows one frame.

## Changing it

- A line: edit `script.json`, run `voice.mjs` and `timeline.mjs`; the picture follows the words (a scene looks its
  moments up by word in `Film.tsx`, and fails loudly if a word it needs is gone).
- The balance: `mix.mjs --score-db -12 --voice-db 5` (the generated score is mastered much louder than the voice).
