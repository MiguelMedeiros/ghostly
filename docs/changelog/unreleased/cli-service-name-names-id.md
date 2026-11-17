---
section: Fixed / CLI
---
- `ghostly service enable`, `share` and `remove` given a service's name instead of its id (`"My App"` for `my-app`) now say which id to use: `No service with id "My App". "My App" is the name of my-app: use its id`, listing every id when several services share the name. Before, they said there was no service of that name, while `service list` showed one. Same `not_found` code and exit 3. Their help now says `<service>` is the id `service add` and `service list` show.
