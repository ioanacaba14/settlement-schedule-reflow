import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ReflowService } from "./reflow/reflow.service.js";
import type { ReflowInput, SettlementChannel, SettlementTask, TradeOrder } from "./reflow/types.js";
import { toCsv } from "./utils/csv.js";

interface ScenarioFile {
  name: string;
  description: string;
  settlementTasks: SettlementTask[];
  settlementChannels: SettlementChannel[];
  tradeOrders: TradeOrder[];
}

export interface ScenarioRunResult {
  fileName: string;
  scenarioName: string;
  description: string;
  csv: string;
  changedCount: number;
  totalCount: number;
  explanation: string[];
}

const CSV_COLUMNS = [
  "taskReference",
  "taskType",
  "channel",
  "dependsOn",
  "isRegulatoryHold",
  "originalStart",
  "originalEnd",
  "newStart",
  "newEnd",
  "deltaMinutes",
  "reason",
];

/** Loads one scenario JSON file, runs the reflow algorithm, and builds a before/after/reason CSV. */
export function runScenarioFile(filePath: string): ScenarioRunResult {
  const scenario = JSON.parse(readFileSync(filePath, "utf-8")) as ScenarioFile;

  const input: ReflowInput = {
    settlementTasks: scenario.settlementTasks,
    settlementChannels: scenario.settlementChannels,
    tradeOrders: scenario.tradeOrders,
  };

  const originalById = new Map(scenario.settlementTasks.map((task) => [task.docId, task]));
  const taskReferenceById = new Map(scenario.settlementTasks.map((task) => [task.docId, task.data.taskReference]));
  const channelNameById = new Map(scenario.settlementChannels.map((channel) => [channel.docId, channel.data.name]));

  const result = new ReflowService().reflow(input);
  const changeByTaskId = new Map(result.changes.map((change) => [change.taskId, change]));

  const rows = result.updatedTasks.map((task) => {
    const original = originalById.get(task.docId)!;
    const change = changeByTaskId.get(task.docId);
    const reason = task.data.isRegulatoryHold
      ? "Regulatory hold — fixed, cannot be rescheduled"
      : (change?.reason ?? "No change — already satisfies all constraints");

    return {
      taskReference: task.data.taskReference,
      taskType: task.data.taskType,
      channel: channelNameById.get(task.data.settlementChannelId) ?? task.data.settlementChannelId,
      dependsOn: task.data.dependsOnTaskIds.map((id) => taskReferenceById.get(id) ?? id).join(" | "),
      isRegulatoryHold: task.data.isRegulatoryHold ? "yes" : "no",
      originalStart: original.data.startDate,
      originalEnd: original.data.endDate,
      newStart: task.data.startDate,
      newEnd: task.data.endDate,
      deltaMinutes: change?.deltaMinutes ?? 0,
      reason,
    };
  });

  return {
    fileName: path.basename(filePath),
    scenarioName: scenario.name,
    description: scenario.description,
    csv: toCsv(rows, CSV_COLUMNS),
    changedCount: result.changes.length,
    totalCount: result.updatedTasks.length,
    explanation: result.explanation,
  };
}

/** Runs every *.json scenario file in scenariosDir, writing one CSV per scenario into outputDir. */
export function runAllScenarios(scenariosDir: string, outputDir: string): ScenarioRunResult[] {
  mkdirSync(outputDir, { recursive: true });

  const files = readdirSync(scenariosDir)
    .filter((file) => file.endsWith(".json"))
    .sort();

  return files.map((file) => {
    const result = runScenarioFile(path.join(scenariosDir, file));
    const outFile = path.join(outputDir, file.replace(/\.json$/, ".csv"));
    writeFileSync(outFile, result.csv, "utf-8");
    return result;
  });
}
