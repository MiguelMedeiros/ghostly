---
section: Fixed / CLI
---
- On the CLI's socket, `service.share` with `"shared": false` takes a contact's access to your web app back, and `service.enable` with `"enabled": false` turns the app off, as `off: true` does. Before, both read only `off`, so sending back the answer's own key gave the contact access, or turned the app on. The key beside an `off` that says the opposite is refused.
