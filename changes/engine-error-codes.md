---
section: For developers
---
- The engine's known errors have stable codes: `ENGINE_ERRORS` in `@ghostly/core` (`engineError(code, values)`, `parseEngineError(text)`). Their English text is unchanged, so the CLI prints the same words; an `EngineError` carries its code as `engineCode`.
