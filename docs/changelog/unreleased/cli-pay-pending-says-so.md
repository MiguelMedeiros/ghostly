---
section: Fixed / CLI
---
- A `pay` that the mint has not settled yet (it is pending, or its answer was lost) now says so: with `paid: false` comes a `note` naming the sats set aside for it, that it settles by itself and is never paid twice, and the commands to check it. Before, it answered `paid: false` and nothing else. `ghostly help pay` says what `paid: false` means.
