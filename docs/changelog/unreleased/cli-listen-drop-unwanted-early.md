---
section: Fixed / CLI
---
- `ghostly listen --type …` now drops events of other types the moment they arrive. Before, while a webhook or `--exec` was slow or down, they piled up behind the wanted event. A busy app could fill the listener's memory with tens of MB of events it was going to drop anyway, then make it pause.
