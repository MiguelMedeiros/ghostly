---
section: Fixed / Calls
---
- In the CLI, a program that writes its audio to a call in chunks of any size keeps sounding right after `ghostly call flush`, or after the queue was full and dropped some of it. Before, when the drop cut a sample in half, every sample after it was read a byte off and the contact heard loud noise until the call ended.
