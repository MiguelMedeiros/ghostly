---
section: Fixed / CLI
---
- `ghostly listen --webhook` posts an event once when the bridge refuses it (a 4xx or a redirect), as the line on stderr says. Before, it posted the event three times, so the bridge logged three refusals for one event.
