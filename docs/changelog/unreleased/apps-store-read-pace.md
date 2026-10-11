---
section: Fixed / Apps
---
- Apps, stores: reading a store's list no longer holds the page while its publishers' revocations are checked. A list may carry up to 4096 of them, each a signature check, and all were checked in one go before anything else could run: about 10 seconds with a full list, at the preview in Add, again at Add, and at every refresh of a list that had changed. They are now checked a few milliseconds at a time, and one already checked is not checked again when the list changes around it or when Add reads what the preview just read.
