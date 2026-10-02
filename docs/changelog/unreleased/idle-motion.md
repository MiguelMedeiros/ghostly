---
section: Fixed / Everywhere
---
- An app left open and untouched no longer keeps a processor busy. The ghost of the empty chat list moved forever, so a new profile's window was drawn 60 times a second: on Linux that cost about a fifth of a core for as long as the app was open, even with the window on another workspace. It now says boo three times and rests, as does the syncing mark on a chat's row.
- Motion that says something is under way rests when it has lasted: the pairing scene and its small glyph in the header become a still picture after a minute in the same stage (an invite nobody has opened yet), a "connecting" dot stops pulsing after half a minute, and a spinner stops after two minutes. They move again when their state changes.
- Every looping animation holds still while the window is hidden or behind other windows, and goes on when it is back.
