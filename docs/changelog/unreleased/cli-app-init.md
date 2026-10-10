---
section: For developers / CLI
release: 1.2
---
- `ghostly app init <dir>` starts an app: a `ghostly-app.json`, an `index.html` that says hello to the contact, typed against `@ghostlytools/sdk/app`, and a README with the way to a store. `ghostly app publish <dir> --key <file>` signs the folder as it is. `--name` and `--title` set the app's name and title (by default from the folder's name), and nothing is written over a file that is there unless `--force`.
