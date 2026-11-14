// Summary of a vitest JSON report: counts, then each failure (first lines).
import { readFileSync } from "node:fs";

const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
console.log(`total ${report.numTotalTests} passed ${report.numPassedTests} failed ${report.numFailedTests} files-failed ${report.numFailedTestSuites}`);
for (const file of report.testResults) {
  if (file.status === "failed" && !file.assertionResults.some((a) => a.status === "failed")) console.log("FILE", file.name, file.message.slice(0, 1500));
  for (const a of file.assertionResults) if (a.status === "failed") console.log("FAIL", file.name.split("/").pop(), "::", a.fullName, "\n ", a.failureMessages.join("\n").slice(0, 900));
}
