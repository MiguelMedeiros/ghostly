---
section: Fixed / CLI
---
- `ghostly listen --type chat` (or `message`, `daemon`, any family name) now lets that family's events through, as its help said. Before, a family only matched written with its dot (`chat.`), and `--type chat` stayed silent for good. A dotted type such as `group.message` is still that type alone.
