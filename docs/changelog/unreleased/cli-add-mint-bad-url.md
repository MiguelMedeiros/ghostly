---
section: Fixed / CLI
---
- `wallet add-mint` with something that is not a URL, or a mint not on https, answers code `bad_request` with the same words ("That is not a valid mint URL", "Mints must use https"), as `service add` does. Before, it answered `engine`, which a bot reads as the engine failing and may retry.
