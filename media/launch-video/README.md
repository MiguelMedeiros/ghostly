# Ghostly v1.0 launch film

A 45 second motion film cut to the music: 24 bars at 128 BPM, every cut, motion and sound effect on a beat. No
voice; short words on screen. The picture is the app's own components (wallet cards, ID cards, chat bubbles, the
invite card, the secret guard) drawn against the test engine, not screen recordings. The sound effects are the
app's own cues (`src/assets/sounds`).

## How it fits together

| File | What it does |
|---|---|
| `timeline.js` | The one clock: the grid (`at(bar, beat)`), every moment the picture moves on (`M`), and the cue each moment plays (`CUES`). The picture and the sound both read it, so they cannot drift apart. |
| `film/` | The film page (Vite, React). `Film.tsx` has the eight scenes; every style is a function of the film's time `t`, and the app's own transitions are off (`film.css`), so any frame renders the same in any worker. `assets.ts` holds the made-up data (cards, messages, an invite from the tests). |
| `music.mjs` | The score from ElevenLabs: an intro, a drop, plus a riser, an impact and a downlifter. Each generation is cached in `cache/music/` by the hash of its request, so a rerun bills nothing. |
| `beats.mjs` | Measures a music file's tempo, beats and bar levels (spectral flux onsets, comb search). No listening needed. |
| `render.mjs` | Serves `film/`, seeks every frame in headless Chromium and encodes `out/<format>/picture.mp4`. Also stills and a contact sheet. |
| `mix.mjs` | Lays the score on the grid (each part stretched to exactly 128 BPM from its measured tempo), places every cue so its attack lands on its moment, ducks the score under the cues, normalizes to -14 LUFS / -1 dBTP and muxes `out/ghostly-v1.0-<format>.mp4`. |
| `check.mjs` | The sync report: the score's measured beats against the grid, each cue's measured attack, the frame where each motion starts, loudness. Writes `out/<format>/sync.md`. |

Outputs, frames and generations (`out/`, `cache/`) are not in git.

## Render

From the repository root, after `npm ci`:

```bash
( set -a; . ~/code/liquid-saga/.env.local; set +a; node media/launch-video/music.mjs )
```

Only needed once (or after a prompt changes); the key is read from the environment and never written anywhere.

```bash
lockf -k /tmp/ghostly-heavy.lock node media/launch-video/render.mjs --format 16x9 --workers 4
```

```bash
node media/launch-video/mix.mjs --format 16x9
```

```bash
node media/launch-video/check.mjs --format 16x9
```

`--format` is `16x9` (1920x1080), `9x16` (1080x1920) or `1x1` (1080x1080); each has its own layout. 60 fps by
default (`--fps`). On a 14-core Mac the 16:9 picture takes about two minutes with 4 workers.

Looking at a moment without rendering: `node media/launch-video/render.mjs --stills 13.2,30.4` writes
`out/16x9/stills/`, `--sheet` a contact sheet with a still per bar. `npx vite --config media/launch-video/vite.config.ts`
serves the page; `http://localhost:5391/?t=13.2&format=9x16` shows one frame.

## Changing it

- Pacing: one idea per bar, never two new words on the same beat, and nothing pulses or shakes with the kick
  (Miguel's first review: too fast to follow, the beat bumps felt cheap). Arrivals ease out from the beat, so
  what you see starts where you hear it.
- A moment: move it in `M` (bar and beat) and the motion and its cue move together.
- A cue's level: its `db` in `CUES`; all cues against the score: `mix.mjs --cues-db`.
- The score: edit a prompt in `music.mjs` and run it again (only the changed part is billed). Then run
  `node media/launch-video/beats.mjs media/launch-video/cache/music/<part>.mp3 --bpm 128` to see its tempo and where
  its body is, before `mix.mjs` stretches it onto the grid.
