#!/usr/bin/env node
import { run } from "./main";
import { quietWebStorage } from "./runtime/webStorage";

// Before any command reads it: Node 25+ warns on stderr at the first read of a localStorage it was given no file for.
quietWebStorage();
void run(process.argv.slice(2));
