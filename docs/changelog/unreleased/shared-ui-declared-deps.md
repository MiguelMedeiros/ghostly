---
section: For developers / Dependencies
---
- The root package.json declares highlight.js (in lowlight's `~11.11.0` range, so one copy is bundled) and @types/hast, which the shared UI's code blocks import, instead of getting them through lowlight. The test that holds every workspace's `src` imports to its own package.json also holds apps/ui's to the root's.
