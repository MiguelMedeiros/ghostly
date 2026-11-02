---
section: Fixed / CLI
---
- `ghostly help`, `help <group>` and `<command> --help` now fit the terminal: summaries and options wrap between words at its width (or `$COLUMNS`), and below about 100 columns each summary goes under its command, 4 in. Before, the usage column was 58 wide whatever the terminal: at 80 columns, 170 of the 195 lines ran over and every summary broke mid-word into column 0. Piped, the help stays one row per line, as before. A bare `ghostly` in a Ghostly folder with no profile yet starts with the first steps: make an invite, join one, keep the profile online.
