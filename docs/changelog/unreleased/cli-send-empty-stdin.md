---
section: Fixed / CLI
---
- `ghostly send`, `ghostly edit`, `ghostly group send` and `ghostly group edit` with no text, and `ghostly wallet redeem` with no token, run with stdin a pipe nobody writes, no longer wait for ever without a word: as the joins, after 2 s stderr says what it waits for on stdin, and after 60 s with nothing on stdin it ends with the usage error. Text that started coming is waited for to the end, and `--stdin` still waits as long as it takes.
