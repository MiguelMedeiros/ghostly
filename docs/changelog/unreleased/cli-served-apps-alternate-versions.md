---
section: Fixed / CLI
---
- A bot serving apps no longer reads `apps.json` again and works out every served app's id in a chat each time a contact's app opens with another version than its last open. A contact alternating two versions at the allowed rate, with 16 served apps open, took about 30% of a core; it now costs the same as repeating one version (under 1%). A change to the served apps is still picked up at the next open.
