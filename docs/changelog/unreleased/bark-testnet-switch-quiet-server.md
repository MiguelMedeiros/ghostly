---
section: Fixed / Everywhere
---
- A Testnet Bark wallet can move to another test network (Signet, Regtest) or be restored over when the server of the one it is on has stopped answering: the app waits 10 seconds for that server to say the wallet is empty, then goes by the last balance it read, pending and exiting coins included. Before, the switch waited on that server for as long as it stayed quiet. A Mainnet wallet still waits for its server's own word.
