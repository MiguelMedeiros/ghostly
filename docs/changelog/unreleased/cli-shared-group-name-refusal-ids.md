---
section: Fixed / CLI
---
- A 1:1 command given a name several groups share (`send Crew hi`, `call start Crew`) now carries their ids in `--json` (`details.matches`, as `group show Crew` does), where its words asked for the id of the group meant and gave none. `listen --from Crew` offers `ghostly listen --group <group>` with those ids, where it offered `group show`.
