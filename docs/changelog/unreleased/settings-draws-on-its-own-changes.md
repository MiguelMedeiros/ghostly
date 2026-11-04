---
section: Fixed / Everywhere
---
- Settings no longer draws again on every change elsewhere in the app. Each change, up to 20 a second while a file moves, made the whole page draw again, about 3 ms each. Now it draws only when something it shows changes. In a test, 20 changes elsewhere caused no draws on Settings or its Network section; before, each one drew the page.
