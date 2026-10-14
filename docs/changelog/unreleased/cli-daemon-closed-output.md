---
section: Fixed / CLI
---
- A `ghostly daemon` whose output nobody reads any more (the process that started it was killed, or the pipe it wrote to closed) no longer takes a full processor core and stops on SIGTERM again. It used to report each failed write with another write that failed, without end, and answered no command.
