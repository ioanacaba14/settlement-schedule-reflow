import { DateTime } from "luxon";
import type { SettlementTask } from "./types.js";

export interface ValidationIssue {
  taskId: string;
  taskReference: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

/**
 * Post-hoc sanity check over a produced schedule: independent of however the
 * schedule was built, does it actually respect channel exclusivity and
 * dependency ordering? Used both by ReflowService (defense in depth) and by
 * tests.
 *
 * @upgrade Phase 4/5: extend to also validate operating-hours and
 * blackout-window compliance once those constraints exist.
 */
export function validateSchedule(tasks: SettlementTask[]): ValidationResult {
  const issues: ValidationIssue[] = [
    ...findChannelConflicts(tasks),
    ...findUnsatisfiedDependencies(tasks),
  ];

  return { valid: issues.length === 0, issues };
}

function findChannelConflicts(tasks: SettlementTask[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const byChannel = new Map<string, SettlementTask[]>();

  for (const task of tasks) {
    const channelId = task.data.settlementChannelId;
    const bucket = byChannel.get(channelId) ?? [];
    bucket.push(task);
    byChannel.set(channelId, bucket);
  }

  for (const channelTasks of byChannel.values()) {
    const sorted = [...channelTasks].sort(
      (a, b) => DateTime.fromISO(a.data.startDate).toMillis() - DateTime.fromISO(b.data.startDate).toMillis(),
    );

    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      if (!prev || !curr) continue;

      const prevEnd = DateTime.fromISO(prev.data.endDate);
      const currStart = DateTime.fromISO(curr.data.startDate);

      if (currStart < prevEnd) {
        issues.push({
          taskId: curr.docId,
          taskReference: curr.data.taskReference,
          message: `Overlaps with task ${prev.data.taskReference} on the same channel (${prev.data.endDate} vs ${curr.data.startDate})`,
        });
      }
    }
  }

  return issues;
}

function findUnsatisfiedDependencies(tasks: SettlementTask[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const byId = new Map(tasks.map((task) => [task.docId, task]));

  for (const task of tasks) {
    const start = DateTime.fromISO(task.data.startDate);

    for (const depId of task.data.dependsOnTaskIds) {
      const dep = byId.get(depId);
      if (!dep) {
        issues.push({
          taskId: task.docId,
          taskReference: task.data.taskReference,
          message: `Depends on unknown task id "${depId}"`,
        });
        continue;
      }

      const depEnd = DateTime.fromISO(dep.data.endDate);
      if (start < depEnd) {
        issues.push({
          taskId: task.docId,
          taskReference: task.data.taskReference,
          message: `Starts before dependency ${dep.data.taskReference} completes (${dep.data.endDate})`,
        });
      }
    }
  }

  return issues;
}
