---
section: Fixed / CLI
---
- `ghostly service enable`, `service remove`, `service share`, `identity remove`, `identity withdraw`, `identity cancel` and `message retry` answer `not_found` (exit 3) for a service, an identity proof, a draft or a message that does not exist, naming it and where to look (`No service "nope" (ghostly service list)`). Before, each answered as done with exit 0: a mistyped service id read `"shared": true` with a contact.
