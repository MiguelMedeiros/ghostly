---
section: For developers / Apps
release: 1.2
---
- The Chess end-to-end tests run a pinned copy of Chess (`e2e/fixtures/chess`) instead of building it on the fly. It is Chess 2.3.0, taken from the bundle its publisher signed in Chess's own repository: `node tools/scripts/refresh-chess-fixture.mjs --bundle <a file, or a URL pinned to a commit>` checks the publisher key and the hashes and writes it, and `--check` compares the fixture with that bundle again. The fixture is no longer built from `apps/mini/chess`, and CI no longer compares the two.
- The Chess end-to-end tests play the new board (a game starts with an invitation the contact accepts), check that the install screen asks for your name in the chat, and cover the update from Chess 1.0.2 to 2.3.0, which waits until the person agrees to that new permission.
