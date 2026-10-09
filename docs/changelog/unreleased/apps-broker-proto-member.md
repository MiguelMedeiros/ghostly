---
section: For developers / Apps
release: 1.2
---
- Behind the apps flag: a value an app stores or sends with a member named `__proto__` (a word a person typed, say) is kept whole, as `JSON.stringify` writes it. Before, `storage.set` refused it as `too-large`, and `chat.send` and a value with `__proto__` at its top lost that member without a word.
