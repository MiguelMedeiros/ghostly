---
section: Fixed / CLI
---
- When the person a CLI program called loses their app mid-call (it crashed, was closed by the phone, or lost its network) and calls back at once, their new call now rings as `call.incoming`, and the first call ends as `remote-hangup`. Before, the new call never rang, and once the CLI gave the dead call up their chat said it had been declined.
