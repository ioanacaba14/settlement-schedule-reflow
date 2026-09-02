import { DateTime } from "luxon";
import { calculateEndDateWithOperatingHours, nextOperatingInstant } from "../utils/date-utils.js";
import { validateSchedule } from "./constraint-checker.js";
import { buildDependencyGraph, topologicalSort } from "./dependency-graph.js";
import type { OperatingHoursWindow, ReflowInput, ReflowResult, ScheduleChange, SettlementTask } from "./types.js";

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
 * @upgrade Phase 5: blackout windows aren't factored in yet — they'll plug
 * into the same channelBusy list as regulatory holds do below (blocked time
 * with no owning task), since from the placement search's point of view a
 * blackout is just more "already booked" time on the channel.
 */
export class ReflowService {
  reflow(input: ReflowInput): ReflowResult {
    const { settlementTasks, settlementChannels } = input;
    const graph = buildDependencyGraph(settlementTasks);
    const tasksById = graph.tasksById;
    const channelsById = new Map(settlementChannels.map((channel) => [channel.docId, channel]));

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

      const channel = channelsById.get(task.data.settlementChannelId);
      if (!channel) {
        throw new Error(
          `Task ${task.data.taskReference} references unknown settlement channel id "${task.data.settlementChannelId}".`,
        );
      }

      const depFloor = latestDependencyEnd(task, newTimesById, tasksById) ?? originalStart;
      const earliestStart = depFloor > originalStart ? depFloor : originalStart;

      const busy = channelBusy.get(task.data.settlementChannelId) ?? [];
      const {
        start: newStart,
        end: newEnd,
        blockedBy,
        pausedForOperatingHours,
      } = findEarliestAvailableSlot(busy, earliestStart, task.data.durationMinutes, channel.data.operatingHours);

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
      // The end can move even when the start doesn't: a task starting right
      // before close still has its completion pushed to the next window, so
      // "did anything change" has to compare both, not just the start delta.
      const spannedOperatingHoursPause = newEnd.diff(newStart, "minutes").minutes > task.data.durationMinutes;
      const startChanged = !newStart.equals(originalStart);
      const endChanged = !newEnd.equals(originalEnd);

      if (startChanged || endChanged) {
        changes.push({
          taskId: task.docId,
          taskReference: task.data.taskReference,
          originalStartDate: task.data.startDate,
          originalEndDate: task.data.endDate,
          newStartDate: updatedTask.data.startDate,
          newEndDate: updatedTask.data.endDate,
          deltaMinutes,
          reason: buildReason({ depFloor, originalStart, blockedBy, pausedForOperatingHours, spannedOperatingHoursPause }),
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

const MAX_PLACEMENT_ITERATIONS = 1000;

/**
 * Finds the first slot of at least `durationMinutes` of *operating* time on a
 * channel at or after `earliestStart`, respecting both the channel's
 * operating hours and its already-booked intervals.
 *
 * These two constraints interact: jumping past a channel conflict can land
 * outside operating hours, and snapping into the next operating window can
 * land inside another booked interval. So this alternates between the two
 * checks until a candidate start satisfies both simultaneously — pure
 * "operating hours only" math lives in date-utils.ts; this is where it meets
 * the channel's busy-interval list.
 */
function findEarliestAvailableSlot(
  busy: BusyInterval[],
  earliestStart: DateTime,
  durationMinutes: number,
  operatingHours: OperatingHoursWindow[],
): { start: DateTime; end: DateTime; blockedBy: string | null; pausedForOperatingHours: boolean } {
  let candidateStart = earliestStart;
  let blockedBy: string | null = null;
  let pausedForOperatingHours = false;

  for (let iteration = 0; iteration < MAX_PLACEMENT_ITERATIONS; iteration++) {
    const snapped = nextOperatingInstant(candidateStart, operatingHours);
    if (!snapped.equals(candidateStart)) {
      candidateStart = snapped;
      pausedForOperatingHours = true;
      continue;
    }

    const candidateEnd = calculateEndDateWithOperatingHours(candidateStart, durationMinutes, operatingHours);
    const conflict = busy.find((interval) => interval.start < candidateEnd && candidateStart < interval.end);

    if (!conflict) {
      return { start: candidateStart, end: candidateEnd, blockedBy, pausedForOperatingHours };
    }

    candidateStart = conflict.end;
    blockedBy = conflict.taskReference;
  }

  throw new Error("Could not find an available channel slot — this indicates a bug in constraint resolution.");
}

function buildReason(params: {
  depFloor: DateTime | null;
  originalStart: DateTime;
  blockedBy: string | null;
  pausedForOperatingHours: boolean;
  spannedOperatingHoursPause: boolean;
}): string {
  const { depFloor, originalStart, blockedBy, pausedForOperatingHours, spannedOperatingHoursPause } = params;
  const parts: string[] = [];

  if (depFloor && depFloor > originalStart) {
    parts.push(`waited for an upstream dependency to complete at ${depFloor.toUTC().toISO()}`);
  }
  if (blockedBy) {
    parts.push(`shifted later to avoid a channel conflict with task ${blockedBy}`);
  }
  if (pausedForOperatingHours) {
    parts.push("requested start fell outside the channel's operating hours, so processing was snapped to the next window");
  }
  if (spannedOperatingHoursPause) {
    parts.push("processing did not fit before the channel closed, so it paused and resumed in the next operating window");
  }
  if (parts.length === 0) {
    parts.push("shifted to satisfy scheduling constraints");
  }

  return parts.join("; ");
}
