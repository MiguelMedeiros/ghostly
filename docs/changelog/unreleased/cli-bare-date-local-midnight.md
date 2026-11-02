---
section: Fixed / CLI
---
- `routine send --next`, `usage send --resets` and `--also week=80@<time>` read a date alone (`2026-11-03`) as local midnight, as they already read a date with a time and no zone (`2026-11-03 09:00`) as local time. Before, a date alone was UTC midnight, so in UTC-03 a routine meant for the next day showed its next run at 21:00 the evening before. A `Z` or an offset (`+02:00`) is kept as given, and the flags' help now shows the forms they take.
