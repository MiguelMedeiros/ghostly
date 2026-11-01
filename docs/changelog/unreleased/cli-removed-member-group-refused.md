---
section: Fixed / CLI
---
- A group command from someone no longer in the group is now refused (`refused`) as every other one is: `group rename`, `group rotate`, `group remove`, `group admin`, `group hub` and `group picture` answered `engine`, the code for the engine failing, and `group typing` answered `bad_request`; it now gives the group's reason ("You were removed from this group"), as `group send` does.
