---
section: For developers / Apps
release: 1.2
---
- Behind the apps flag: Ghostly reads app manifests, store indexes and listings that carry a key it does not know yet, instead of refusing them, so later formats can add optional fields. The signature still covers every byte, and `ghostly app build` and `ghostly store sign` still refuse an unknown key. An app installed from a store now updates only to the version that store lists, never to a newer one found at its publisher's repository first.
