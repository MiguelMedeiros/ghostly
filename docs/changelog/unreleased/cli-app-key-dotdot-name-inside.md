---
section: Fixed / CLI
---
- `ghostly app publish --key` refuses a key file inside the app's folder whose name starts with two dots (`hello/..k.key`), like any other key there, instead of making the key in the folder that is published.
