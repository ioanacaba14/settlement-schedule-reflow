import { DateTime } from "luxon";
import type { SettlementChannel, SettlementTask } from "./types.js";

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
 * schedule was built, does it actually respect channel exclusivity,
 * dependency ordering, and blackout windows? Used both by ReflowService
 * (defense in depth) and by tests.
 *
 * @upgrade extend to also validate operating-hours compliance (recompute
 * each task's expected end from its recorded start via
 * calculateEndDateWithOperatingHours and compare) now that both operating
 * hours and blackout windows exist.
 */
export function validateSchedule(tasks: SettlementTask[], channels: SettlementChannel[]): ValidationResult {
  const channelsById = new Map(channels.map((channel) => [channel.docId, channel]));
  const issues: ValidationIssue[] = [
    ...findChannelConflicts(tasks),
    ...findUnsatisfiedDependencies(tasks),
    ...findBlackoutViolations(tasks, channelsById),
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

function findBlackoutViolations(
  tasks: SettlementTask[],
  channelsById: Map<string, SettlementChannel>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const task of tasks) {
    const channel = channelsById.get(task.data.settlementChannelId);
    if (!channel) continue; // dangling channel reference is reported elsewhere

    const start = DateTime.fromISO(task.data.startDate);
    const end = DateTime.fromISO(task.data.endDate);

    for (const blackout of channel.data.blackoutWindows) {
      const blackoutStart = DateTime.fromISO(blackout.startDate);
      const blackoutEnd = DateTime.fromISO(blackout.endDate);

      if (start < blackoutEnd && blackoutStart < end) {
        issues.push({
          taskId: task.docId,
          taskReference: task.data.taskReference,
          message:
            `Overlaps blackout window on ${channel.data.name} ` +
            `(${blackout.reason ?? "unspecified reason"}): ${blackout.startDate} - ${blackout.endDate}`,
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
