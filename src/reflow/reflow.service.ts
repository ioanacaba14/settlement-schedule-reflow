import { DateTime } from "luxon";
import { ChannelAvailability, findEarliestAvailableSlot, registerBlackoutWindows, registerHold } from "./channel-availability.js";
import { validateSchedule } from "./constraint-checker.js";
import { buildDependencyGraph, topologicalSort } from "./dependency-graph.js";
import type { ReflowInput, ReflowResult, ScheduleChange, SettlementTask } from "./types.js";

/**
 * Entry point for the reflow algorithm: takes the current settlement tasks,
 * channels, and trade orders, and produces a valid, constraint-respecting
 * schedule.
 */
export class ReflowService {
  reflow(input: ReflowInput): ReflowResult {
    const { settlementTasks, settlementChannels } = input;
    const graph = buildDependencyGraph(settlementTasks);
    const tasksById = graph.tasksById;
    const channelsById = new Map(settlementChannels.map((channel) => [channel.docId, channel]));
    if (channelsById.size !== settlementChannels.length) {
      const seen = new Set<string>();
      const duplicates = new Set<string>();
      for (const channel of settlementChannels) {
        if (seen.has(channel.docId)) duplicates.add(channel.docId);
        seen.add(channel.docId);
      }
      throw new Error(`Duplicate channel docId(s) found: ${[...duplicates].join(", ")} — channel ids must be unique.`);
    }

    // Validated up front for every task (including regulatory holds — a hold
    // otherwise skips the per-task channel lookup below entirely, since it
    // never reaches the movable-task branch that does it) rather than only
    // checking once we get to placing a movable task.
    for (const task of settlementTasks) {
      if (!channelsById.has(task.data.settlementChannelId)) {
        throw new Error(
          `Task ${task.data.taskReference} references unknown settlement channel id "${task.data.settlementChannelId}".`,
        );
      }
    }

    const processingOrder = topologicalSort(graph);

    // Blackout windows and regulatory holds are both immovable, so their
    // windows are staked out on their channel before any movable task is
    // placed — everything else has to route around them regardless of
    // processing order. Blackouts go first: registering a hold checks for
    // overlap against whatever's already booked, so a hold landing on top of
    // a blackout is reported as exactly that conflict.
    const availability = new ChannelAvailability();
    for (const channel of settlementChannels) {
      registerBlackoutWindows(channel, availability);
    }
    for (const task of processingOrder) {
      if (task.data.isRegulatoryHold) {
        registerHold(task, availability);
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

      // Existence already validated up front; every task's channel is guaranteed to be in the map here.
      const channel = channelsById.get(task.data.settlementChannelId)!;

      const depFloor = latestDependencyEnd(task, newTimesById, tasksById) ?? originalStart;
      const earliestStart = depFloor > originalStart ? depFloor : originalStart;

      const {
        start: newStart,
        end: newEnd,
        blockedBy,
        pausedForOperatingHours,
      } = findEarliestAvailableSlot(
        availability,
        task.data.settlementChannelId,
        earliestStart,
        task.data.durationMinutes,
        channel.data.operatingHours,
      );

      availability.registerPlacement(task.data.settlementChannelId, {
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
    const validation = validateSchedule(updatedTasks, settlementChannels);
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
    parts.push(`shifted later to avoid a scheduling conflict with ${blockedBy}`);
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
