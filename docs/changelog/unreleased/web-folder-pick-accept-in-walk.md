---
section: Fixed / Apps
---
- On the web in Chrome and Edge, an app that asks for a folder of some file types only (a film player asking for `.mp4`) now gets every such file in it, however many other files the folder holds. Before, the files of other types and the hidden ones were each read from the disk and counted toward the 100,000 files an app may link: in a folder with more than 100,000 photos, a player could get none of its 50 films, with no message, after reading every photo. A folder with more than 100,000 files of the asked types is now refused as too large, as on the Desktop, never linked in part.
