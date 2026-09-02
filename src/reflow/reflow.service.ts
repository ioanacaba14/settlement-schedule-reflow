import { DateTime } from "luxon";
import { validateSchedule } from "./constraint-checker.js";
import { buildDependencyGraph, topologicalSort } from "./dependency-graph.js";
import type { ReflowInput, ReflowResult, ScheduleChange, SettlementTask } from "./types.js";

interface BusyInterval {
  start: DateTime;
  end: DateTime;
  taskId: string;
  taskReference: string;
}

/**
 * Entry point for the reflow algorithm: takes the current settlement tasks,
 * channels, and trade orders, and produces a valid, constraint-respecting
 * schedule.
 *
 * @upgrade Phase 4: this currently treats every channel as open 24/7 (no
 * operating hours, no blackout windows) — end = start + durationMinutes on a
 * continuous timeline. Phase 4 swaps that for
 * calculateEndDateWithOperatingHours() from date-utils.ts, and Phase 4/5 also
 * feeds blackout windows into the channel busy-interval list below.
 */
export class ReflowService {
  reflow(input: ReflowInput): ReflowResult {
    const { settlementTasks } = input;
    const graph = buildDependencyGraph(settlementTasks);
    const tasksById = graph.tasksById;

    const processingOrder = topologicalSort(graph);

    // Regulatory holds are immovable, so their windows are staked out on
    // their channel before any movable task is placed — everything else has
    // to route around them regardless of processing order.
    const channelBusy = new Map<string, BusyInterval[]>();
    for (const task of processingOrder) {
      if (task.data.isRegulatoryHold) {
        registerHold(task, channelBusy);
      }
    }

    const updatedTasks: SettlementTask[] = [];
    const changes: ScheduleChange[] = [];
    const newTimesById = new Map<string, { start: DateTime; end: DateTime }>();

    for (const task of processingOrder) {
      const originalStart = DateTime.fromISO(task.data.startDate);
      const originalEnd = DateTime.fromISO(task.data.endDate);

      if (task.data.isRegulatoryHold) {
        assertHoldDependenciesSatisfied(task, originalStart, newTimesById, tasksById);
        newTimesById.set(task.docId, { start: originalStart, end: originalEnd });
        updatedTasks.push(task);
        continue;
      }

      const depFloor = latestDependencyEnd(task, newTimesById, tasksById) ?? originalStart;
      const earliestStart = depFloor > originalStart ? depFloor : originalStart;

      const busy = channelBusy.get(task.data.settlementChannelId) ?? [];
      const { start: newStart, blockedBy } = findEarliestSlot(busy, earliestStart, task.data.durationMinutes);
      const newEnd = newStart.plus({ minutes: task.data.durationMinutes });

      insertSorted(channelBusy, task.data.settlementChannelId, {
        start: newStart,
        end: newEnd,
        taskId: task.docId,
        taskReference: task.data.taskReference,
      });

      newTimesById.set(task.docId, { start: newStart, end: newEnd });

      const updatedTask: SettlementTask = {
        ...task,
        data: {
          ...task.data,
          startDate: newStart.toUTC().toISO()!,
          endDate: newEnd.toUTC().toISO()!,
        },
      };
      updatedTasks.push(updatedTask);

      const deltaMinutes = newStart.diff(originalStart, "minutes").minutes;
      if (deltaMinutes !== 0) {
        changes.push({
          taskId: task.docId,
          taskReference: task.data.taskReference,
          originalStartDate: task.data.startDate,
          originalEndDate: task.data.endDate,
          newStartDate: updatedTask.data.startDate,
          newEndDate: updatedTask.data.endDate,
          deltaMinutes,
          reason: buildReason({ depFloor, originalStart, blockedBy }),
        });
      }
    }

    // Defense in depth: the placement loop above should never produce an
    // invalid schedule, but re-validating independently catches algorithm
    // bugs instead of shipping a silently broken schedule.
    const validation = validateSchedule(updatedTasks);
    if (!validation.valid) {
      const details = validation.issues.map((issue) => `${issue.taskReference}: ${issue.message}`).join("; ");
      throw new Error(`Reflow produced an invalid schedule: ${details}`);
    }

    // Preserve the original task ordering in the output rather than the
    // internal processing order.
    const updatedById = new Map(updatedTasks.map((task) => [task.docId, task]));
    const orderedUpdatedTasks = settlementTasks.map((task) => updatedById.get(task.docId)!);

    const explanation =
      changes.length === 0
        ? ["No changes needed — the existing schedule already satisfies all dependencies and channel constraints."]
        : [
            `Rescheduled ${changes.length} of ${settlementTasks.length} task(s).`,
            ...changes.map((change) => `${change.taskReference}: ${change.reason}`),
          ];

    return { updatedTasks: orderedUpdatedTasks, changes, explanation };
  }
}

function registerHold(task: SettlementTask, channelBusy: Map<string, BusyInterval[]>): void {
  const interval: BusyInterval = {
    start: DateTime.fromISO(task.data.startDate),
    end: DateTime.fromISO(task.data.endDate),
    taskId: task.docId,
    taskReference: task.data.taskReference,
  };

  const existing = channelBusy.get(task.data.settlementChannelId) ?? [];
  const overlapping = existing.find((busy) => interval.start < busy.end && busy.start < interval.end);
  if (overlapping) {
    throw new Error(
      `Regulatory hold ${task.data.taskReference} overlaps with immovable task ${overlapping.taskReference} on the same channel — no valid schedule exists.`,
    );
  }

  insertSorted(channelBusy, task.data.settlementChannelId, interval);
}

function insertSorted(channelBusy: Map<string, BusyInterval[]>, channelId: string, interval: BusyInterval): void {
  const list = channelBusy.get(channelId) ?? [];
  list.push(interval);
  list.sort((a, b) => a.start.toMillis() - b.start.toMillis());
  channelBusy.set(channelId, list);
}

function latestDependencyEnd(
  task: SettlementTask,
  newTimesById: Map<string, { start: DateTime; end: DateTime }>,
  tasksById: Map<string, SettlementTask>,
): DateTime | null {
  let latest: DateTime | null = null;

  for (const depId of task.data.dependsOnTaskIds) {
    const resolved = newTimesById.get(depId);
    const depEnd = resolved ? resolved.end : DateTime.fromISO(tasksById.get(depId)!.data.endDate);
    if (!latest || depEnd > latest) {
      latest = depEnd;
    }
  }

  return latest;
}

function assertHoldDependenciesSatisfied(
  task: SettlementTask,
  holdStart: DateTime,
  newTimesById: Map<string, { start: DateTime; end: DateTime }>,
  tasksById: Map<string, SettlementTask>,
): void {
  const depEnd = latestDependencyEnd(task, newTimesById, tasksById);
  if (depEnd && depEnd > holdStart) {
    throw new Error(
      `Regulatory hold ${task.data.taskReference} cannot be rescheduled, but its dependencies only complete at ` +
        `${depEnd.toUTC().toISO()}, after its fixed start of ${holdStart.toUTC().toISO()} — no valid schedule exists.`,
    );
  }
}

/**
 * Finds the first slot of at least `durationMinutes` on a channel at or after
 * `earliestStart`, skipping past any already-booked interval. Busy intervals
 * are kept sorted, so a single forward scan suffices.
 */
function findEarliestSlot(
  busy: BusyInterval[],
  earliestStart: DateTime,
  durationMinutes: number,
): { start: DateTime; blockedBy: string | null } {
  let candidateStart = earliestStart;
  let blockedBy: string | null = null;

  // `busy` is sorted ascending by start and (by construction) contains no
  // overlapping intervals, so a single forward pass is enough: each time the
  // candidate window collides with a booked interval, jump past it and keep
  // scanning — we never need to re-check earlier intervals.
  for (const interval of busy) {
    const candidateEnd = candidateStart.plus({ minutes: durationMinutes });
    const overlaps = interval.start < candidateEnd && candidateStart < interval.end;
    if (overlaps) {
      candidateStart = interval.end;
      blockedBy = interval.taskReference;
    }
  }

  return { start: candidateStart, blockedBy };
}

function buildReason(params: { depFloor: DateTime | null; originalStart: DateTime; blockedBy: string | null }): string {
  const { depFloor, originalStart, blockedBy } = params;
  const parts: string[] = [];

  if (depFloor && depFloor > originalStart) {
    parts.push(`waited for an upstream dependency to complete at ${depFloor.toUTC().toISO()}`);
  }
  if (blockedBy) {
    parts.push(`shifted later to avoid a channel conflict with task ${blockedBy}`);
  }
  if (parts.length === 0) {
    parts.push("shifted to satisfy scheduling constraints");
  }

  return parts.join("; ");
}
