---
section: Fixed / CLI
---
- `x401 credential add --lable work` answers "Unknown option --lable (did you mean --label?)", as when the file comes first. Before, the mistyped flag was taken as the file: "Too many arguments", or with no word after it "No such file or folder: <folder>/--lable".
