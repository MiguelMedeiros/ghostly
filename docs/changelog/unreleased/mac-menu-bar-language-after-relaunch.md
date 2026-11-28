---
section: Fixed / Desktop
---
- On a Mac, opening Ghostly again after it quit could leave the menu bar in English for the rest of the session, even with a language other than English already chosen: a relaunch starts in the chosen language from the very first screen, so the page's one call to retitle the menu could race the native menu bar still being set up and be lost, with nothing resending it.
