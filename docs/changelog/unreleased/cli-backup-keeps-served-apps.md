---
section: Fixed / CLI
---
- `ghostly profile restore` of a bot that serves apps (`app serve`) brings its served apps back. A backup left out the list of served apps, so the restored copy served none, did not offer apps to its contacts, and `app served` answered an empty list with nothing said.
