import { DateTime } from "luxon";
import { calculateEndDateWithOperatingHours, nextOperatingInstant } from "../utils/date-utils.js";
import type { OperatingHoursWindow, SettlementChannel, SettlementTask } from "./types.js";

export interface BusyInterval {
  start: DateTime;
  end: DateTime;
  taskId: string;
  taskReference: string;
}

/**
 * Per-channel busy-interval tracking: everything a channel has already
 * committed to (blackout windows, regulatory holds, placed tasks), kept
 * sorted by start with no overlaps, so placement can always answer "is this
 * candidate window free?" in O(log k) for an isolated booking.
 *
 * A densely-packed run of back-to-back bookings is the case that actually
 * matters at scale: `findConflict` doesn't just return the first overlap and
 * make the caller re-search after jumping past it (which would cost one
 * outer-loop iteration — and a full Luxon date-math round trip — *per
 * booking* in the run). It merges the whole contiguous run into one answer
 * in a single forward pass, so a wall of k back-to-back bookings costs one
 * placement attempt, not k of them.
 *
 * Insertion is still O(k) (a plain array shift), since a truly O(log k)
 * insert needs a self-balancing tree — flagged as a follow-up if profiling
 * ever shows this is the actual bottleneck.
 */
export class ChannelAvailability {
  private readonly byChannel = new Map<string, BusyInterval[]>();

  private busyFor(channelId: string): BusyInterval[] {
    let list = this.byChannel.get(channelId);
    if (!list) {
      list = [];
      this.byChannel.set(channelId, list);
    }
    return list;
  }

  /**
   * Inserts `interval`, throwing if it overlaps anything already booked on
   * that channel. Used for blackout windows and regulatory holds — both
   * immovable, so an overlap here means the schedule is unsatisfiable rather
   * than something to route around.
   *
   * Uses the *direct* overlap, not the merged-run version `findConflict`
   * uses: this is a diagnostic ("what does the new interval actually
   * overlap?"), and naming the last booking in an unrelated touching run
   * would blame something the new interval never even overlaps.
   */
  registerFixed(channelId: string, interval: BusyInterval, describeConflict: (existing: BusyInterval) => string): void {
    const busy = this.busyFor(channelId);
    const index = insertionIndex(busy, interval.start.toMillis());
    const conflict = findDirectOverlap(busy, index, interval.start, interval.end);
    if (conflict) {
      throw new Error(describeConflict(conflict.interval));
    }
    busy.splice(index, 0, interval);
  }

  /** Inserts a movable task's placed interval. Caller has already confirmed it doesn't overlap. */
  registerPlacement(channelId: string, interval: BusyInterval): void {
    const busy = this.busyFor(channelId);
    busy.splice(insertionIndex(busy, interval.start.toMillis()), 0, interval);
  }

  /**
   * If anything booked on this channel overlaps `[start, end)`, returns a
   * single interval spanning the *entire* contiguous run of touching/
   * overlapping bookings starting there (labeled with the last one's
   * reference — the one whose end actually determines where the run's reach
   * ends) — not just the one booking nearest `start`.
   */
  findConflict(channelId: string, start: DateTime, end: DateTime): BusyInterval | null {
    const busy = this.busyFor(channelId);
    return findMergedConflict(busy, insertionIndex(busy, start.toMillis()), start, end);
  }

  /** Number of intervals booked on a channel so far — used to size the placement search's iteration bound. */
  bookedCount(channelId: string): number {
    return this.byChannel.get(channelId)?.length ?? 0;
  }
}

/** Binary search for the index at which an interval starting at `startMillis` belongs in a sorted-by-start array. */
function insertionIndex(busy: BusyInterval[], startMillis: number): number {
  let lo = 0;
  let hi = busy.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (busy[mid]!.start.toMillis() < startMillis) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Finds the first interval (if any) directly overlapping `[start, end)`,
 * along with its index — only the neighbor just before `index` and the one
 * at `index` can possibly be it, since `busy` is sorted ascending by start
 * with no overlaps among its own entries.
 */
function findDirectOverlap(
  busy: BusyInterval[],
  index: number,
  start: DateTime,
  end: DateTime,
): { interval: BusyInterval; index: number } | null {
  const startMillis = start.toMillis();
  const endMillis = end.toMillis();
  for (const candidateIndex of [index - 1, index]) {
    const candidate = busy[candidateIndex];
    if (candidate && candidate.start.toMillis() < endMillis && startMillis < candidate.end.toMillis()) {
      return { interval: candidate, index: candidateIndex };
    }
  }
  return null;
}

/**
 * Like `findDirectOverlap`, but merges forward through every subsequent
 * interval that touches or overlaps the growing reach, in one pass.
 *
 * Returns a synthetic interval spanning the whole merged run, labeled with
 * the *last* booking in it (not the first): non-overlapping intervals sorted
 * by start necessarily have monotonically increasing ends too, so the last
 * one visited is always the one whose end actually became the new candidate
 * start — that's the one that directly explains the final placement time,
 * not just the one that started the cascade.
 */
function findMergedConflict(busy: BusyInterval[], index: number, start: DateTime, end: DateTime): BusyInterval | null {
  const first = findDirectOverlap(busy, index, start, end);
  if (!first) return null;

  const runStart = first.interval.start;
  let last = first.interval;

  // Touching (not just overlapping) counts as part of the same run: a
  // positive-duration candidate starting exactly where the merged run ends
  // would immediately conflict with an interval that starts right there too.
  let i = first.index + 1;
  while (i < busy.length && busy[i]!.start.toMillis() <= last.end.toMillis()) {
    last = busy[i]!;
    i++;
  }

  return { start: runStart, end: last.end, taskId: last.taskId, taskReference: last.taskReference };
}

export function registerBlackoutWindows(channel: SettlementChannel, availability: ChannelAvailability): void {
  channel.data.blackoutWindows.forEach((blackout, index) => {
    const interval: BusyInterval = {
      start: DateTime.fromISO(blackout.startDate),
      end: DateTime.fromISO(blackout.endDate),
      taskId: `blackout:${channel.docId}:${index}`,
      taskReference: `Blackout (${blackout.reason ?? "unspecified reason"})`,
    };

    availability.registerFixed(
      channel.docId,
      interval,
      (existing) =>
        `Blackout window on channel "${channel.data.name}" (${interval.taskReference}) overlaps with ` +
        `${existing.taskReference} — the channel's configuration is invalid.`,
    );
  });
}

export function registerHold(task: SettlementTask, availability: ChannelAvailability): void {
  const interval: BusyInterval = {
    start: DateTime.fromISO(task.data.startDate),
    end: DateTime.fromISO(task.data.endDate),
    taskId: task.docId,
    taskReference: task.data.taskReference,
  };

  availability.registerFixed(
    task.data.settlementChannelId,
    interval,
    (existing) =>
      `Regulatory hold ${task.data.taskReference} overlaps with ${existing.taskReference} on the same channel — no valid schedule exists.`,
  );
}

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
export function findEarliestAvailableSlot(
  availability: ChannelAvailability,
  channelId: string,
  earliestStart: DateTime,
  durationMinutes: number,
  operatingHours: OperatingHoursWindow[],
): { start: DateTime; end: DateTime; blockedBy: string | null; pausedForOperatingHours: boolean } {
  let candidateStart = earliestStart;
  let blockedBy: string | null = null;
  let pausedForOperatingHours = false;

  // Bounded by how many bookings this channel could possibly force us to
  // jump past, plus slack for interleaved operating-hours snaps — not a flat
  // constant, since a busy channel can legitimately need many jumps.
  const maxIterations = availability.bookedCount(channelId) + 1000;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const snapped = nextOperatingInstant(candidateStart, operatingHours);
    if (!snapped.equals(candidateStart)) {
      candidateStart = snapped;
      pausedForOperatingHours = true;
      continue;
    }

    const candidateEnd = calculateEndDateWithOperatingHours(candidateStart, durationMinutes, operatingHours);
    const conflict = availability.findConflict(channelId, candidateStart, candidateEnd);

    if (!conflict) {
      return { start: candidateStart, end: candidateEnd, blockedBy, pausedForOperatingHours };
    }

    candidateStart = conflict.end;
    blockedBy = conflict.taskReference;
  }

  throw new Error("Could not find an available channel slot — this indicates a bug in constraint resolution.");
}
