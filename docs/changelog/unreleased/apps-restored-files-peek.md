---
section: Fixed / Apps
---
- An app that needs its files again (a profile restored from a backup) no longer downloads a whole newer version from each of its addresses just to set it aside. When its maker has released since, Ghostly now reads the first bytes of each address, sees it is another version and stops there. Before, every Open and every visit to the Apps page downloaded and checked the full file from each address (up to 16 MiB each, 9 addresses), for as long as an update that asks for a new permission was waiting.
