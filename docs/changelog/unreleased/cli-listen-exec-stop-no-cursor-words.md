---
section: Fixed / CLI
---
- A `ghostly listen --exec` without `--cursor`, stopped while its hook runs, no longer says the event "is handed again at the next start": nothing keeps where it stopped, so the next listen begins after the newest event. It now says the event is not handed again and gives the `--since` that runs it again.
