---
section: For developers
---
- The UI's unit tests load the 8 languages in about 30 ms per test file, not about 310 ms. Each of the 495 files loaded all 312 language files as modules of their own, about 140 s of CPU per run in the job that sets how long a merge train batch's CI takes. Each language is now read as one module, in the tests' Vitest config only.
