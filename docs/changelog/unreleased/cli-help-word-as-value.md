---
section: Fixed / CLI
---
- An option's value of `-h` or `--help` is now taken as that value. Before, `ghostly profile set --name --help` or `ghostly edit bob <message> --text -h` printed the command's help, changed nothing and exited 0, so a script read it as done.
