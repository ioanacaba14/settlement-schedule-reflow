import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAllScenarios } from "./scenario-runner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scenariosDir = path.join(__dirname, "data", "scenarios");
const outputDir = path.join(__dirname, "..", "output");

const results = runAllScenarios(scenariosDir, outputDir);

for (const result of results) {
  console.log(`\n=== ${result.scenarioName} ===`);
  console.log(result.description);
  console.log(`Rescheduled ${result.changedCount} of ${result.totalCount} task(s).`);
  console.log(`CSV: output/${result.fileName.replace(/\.json$/, ".csv")}`);
}
