#!/usr/bin/env node
import { enableCompileCache } from "node:module";
import { quietWebStorage } from "./runtime/webStorage";

// Before any command reads it: Node 25+ warns on stderr at the first read of a localStorage it was given no file for.
quietWebStorage();
// Node keeps the compiled code of the CLI's modules on disk (its own cache folder), so the next command parses none of
// it again: about 30 ms of every command. Before the CLI's own modules load, which is why main comes in after it.
enableCompileCache();
const { run } = await import("./main");
void run(process.argv.slice(2));
