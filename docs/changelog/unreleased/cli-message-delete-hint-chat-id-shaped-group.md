---
section: Fixed / CLI
---
- `ghostly message delete <group> <message>` (without `--everyone`) for a group whose name has the shape of a chat's id, such as `misunderstanding` (16 letters), now suggests `ghostly message delete group:<name> <message> --everyone`. Before, it suggested the name alone, and that command answered `No chat`.
