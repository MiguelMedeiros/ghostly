---
section: Fixed / CLI
release: 1.14
---
- A 7th `--button`, a 6th `forward --to`, a 17th `group send --mention`, an `x401 credential add --label` past 80 characters and an `app serve --grant` other than chat or name are now a usage error (exit 2) that names the flag, said before the profile opens, as `--tag`, `--link` and `--also` already were. They were `bad_request` (exit 1) once the profile was open, a one-shot `send` or `forward` going online first, and `--button`'s in the card's words ("Buttons: buttons is a list of 1 to 6"), so a script read a bad command line as the engine refusing.
