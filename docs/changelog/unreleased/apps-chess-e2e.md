---
section: For developers / Apps
---
- Behind the apps flag: Chess sends and keeps every move again. Its game record carried an empty field the broker refused, so no move was ever sent or kept; Chess now writes strict JSON, and the broker reads an app's values as JSON.stringify writes them (WISP 1200).
- Behind the apps flag: a version a store you added removed stays stopped, and runs only after Run anyway (in the app's details, or on its card in a chat); a revoked version never runs. Refreshing or removing a store updates the installed apps at once.
- An end-to-end test plays Chess between two web apps: built and signed by the CLI, installed from a signed store and from the card, Scholar's mate, close and reopen on each side, the game back after a reload, and a tampered bundle, a lower sequence, a removed and a revoked version refused.
- Behind the apps flag: a game no longer flickers to "Your contact closed" when the chat moves to another connection (a switch to WebRTC, a resume): the contact's app is held for 10 seconds while the new connection says it is still open.
