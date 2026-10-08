---
section: For developers / Apps
release: 1.2
---
- Behind the apps flag: Ghostly reads app manifests, store indexes and listings that carry a key it does not know yet, or a client name it does not know in `runtime`, instead of refusing them, so later formats can add optional fields. The signature still covers every byte, and `ghostly app publish`, `ghostly store sign` and a store's check of `listing.json` still refuse an unknown key. An app installed from a store now updates only to the version that store lists, never to a newer one found at its publisher's repository first, and a waiting update the store stops listing is dropped. Removing that store lets the app update from its own repository again. Every listing must carry a jsDelivr URL pinned to a commit, which Ghostly reads first.
