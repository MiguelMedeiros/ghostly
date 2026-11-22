---
section: Fixed / CLI
release: 1.14
---
- `ghostly service enable`, `share` and `remove` now also take a service's name (`"My App"` for `my-app`, in any case) when no other service has it, and answer its id. An id still comes first, and a name several services share is refused as before, naming their ids. Before, any name was refused as `not_found` (exit 3), which a script that relied on that refusal will no longer see.
