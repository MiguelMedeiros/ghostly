---
section: Fixed / CLI
---
- A `react` or `pin` in a 1:1 chat without a daemon now stays until the contact confirmed it, up to `--timeout` (30 s). Before, it answered done in about a second and left with the reaction or the pin unsaid: the contact saw it only with your next command. `--wait none` answers at once, and the answer says `confirmed`.
