---
section: Fixed / CLI
---
- A request on the daemon's socket that gives a field as `null` reads it as left out, as it reads every other field: `call.auto` or `group.auto` with `"on": null` wiped the chats they answer or join from (left out, they only say them), `profile.set` with `"shareProfile": null` stopped sharing the profile, `chat.disconnect` with `"hold": null` lifted a hold and did not disconnect, and a null `days`, `maxFee` or `until` was read as 0. A switch that is on when left out (`group.link`, `chat.accept`) still reads `null` as off.
