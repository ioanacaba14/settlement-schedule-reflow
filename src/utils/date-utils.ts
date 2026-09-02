import { DateTime } from "luxon";
import type { OperatingHoursWindow } from "../reflow/types.js";

const MAX_DAYS_TO_SCAN_FOR_NEXT_WINDOW = 14;

/**
 * Converts Luxon's ISO weekday (Monday=1 ... Sunday=7) to the spec's
 * dayOfWeek convention (Sunday=0 ... Saturday=6).
 */
function toSpecDayOfWeek(dt: DateTime): number {
  return dt.weekday % 7;
}

function windowsForDay(operatingHours: OperatingHoursWindow[], dayOfWeek: number): OperatingHoursWindow[] {
  return operatingHours.filter((window) => window.dayOfWeek === dayOfWeek);
}

/**
 * True if `instant` falls inside one of the channel's operating windows.
 * Windows are half-open [startHour, endHour) — an instant exactly at
 * endHour:00 is outside the window (processing has already paused), matching
 * the spec's example of a task pausing exactly when the window closes.
 */
export function isWithinOperatingHours(instant: DateTime, operatingHours: OperatingHoursWindow[]): boolean {
  const utc = instant.toUTC();
  const dayOfWeek = toSpecDayOfWeek(utc);
  return windowsForDay(operatingHours, dayOfWeek).some(
    (window) => utc.hour >= window.startHour && utc.hour < window.endHour,
  );
}

/** The close of the specific operating window that currently contains `instant`. */
function currentWindowEnd(instant: DateTime, operatingHours: OperatingHoursWindow[]): DateTime {
  const utc = instant.toUTC();
  const dayOfWeek = toSpecDayOfWeek(utc);
  const window = windowsForDay(operatingHours, dayOfWeek).find(
    (w) => utc.hour >= w.startHour && utc.hour < w.endHour,
  );
  if (!window) {
    throw new Error(`${utc.toISO()} is not within any operating window — call isWithinOperatingHours first.`);
  }
  return utc.set({ hour: window.endHour, minute: 0, second: 0, millisecond: 0 });
}

/**
 * Finds the start of the earliest operating window at or after `instant`,
 * scanning forward day by day (so weekends/off-days with no window entry are
 * skipped naturally). Does not assume `instant` itself is outside a window —
 * if a later window starts on the same day, that's a valid answer too.
 */
export function nextOperatingWindowStart(instant: DateTime, operatingHours: OperatingHoursWindow[]): DateTime {
  if (operatingHours.length === 0) {
    throw new Error("Channel has no operating hours defined — cannot schedule any processing on it.");
  }

  const utc = instant.toUTC();

  for (let dayOffset = 0; dayOffset <= MAX_DAYS_TO_SCAN_FOR_NEXT_WINDOW; dayOffset++) {
    const candidateDay = utc.plus({ days: dayOffset }).startOf("day");
    const dayOfWeek = toSpecDayOfWeek(candidateDay);

    const candidateStarts = windowsForDay(operatingHours, dayOfWeek)
      .map((window) => candidateDay.set({ hour: window.startHour }))
      .filter((start) => start >= utc)
      .sort((a, b) => a.toMillis() - b.toMillis());

    if (candidateStarts.length > 0) {
      return candidateStarts[0]!;
    }
  }

  throw new Error(
    `No operating window found within ${MAX_DAYS_TO_SCAN_FOR_NEXT_WINDOW} days of ${utc.toISO()} — ` +
      "channel's operating hours may be misconfigured.",
  );
}

/** Snaps `instant` forward to a valid processing instant: itself if already within a window, else the next window's start. */
export function nextOperatingInstant(instant: DateTime, operatingHours: OperatingHoursWindow[]): DateTime {
  if (isWithinOperatingHours(instant, operatingHours)) {
    return instant;
  }
  return nextOperatingWindowStart(instant, operatingHours);
}

/**
 * The core "pause/resume" calculator: given a start instant and a duration,
 * returns the instant processing actually completes, accounting for
 * operating-hour boundaries. Processing consumes `durationMinutes` of
 * *operating* time — it pauses at the close of each window and resumes at
 * the start of the next one.
 *
 * Example from the spec: a 120-minute task starting Mon 3PM on a channel
 * open Mon–Fri 8AM–4PM processes 60 min Monday (3–4PM), pauses, resumes Tue
 * 8AM, and completes at 9AM.
 */
export function calculateEndDateWithOperatingHours(
  startDate: DateTime,
  durationMinutes: number,
  operatingHours: OperatingHoursWindow[],
): DateTime {
  let remainingMinutes = durationMinutes;
  let current = nextOperatingInstant(startDate, operatingHours);

  while (remainingMinutes > 0) {
    const windowEnd = currentWindowEnd(current, operatingHours);
    const availableMinutes = windowEnd.diff(current, "minutes").minutes;

    if (remainingMinutes <= availableMinutes) {
      return current.plus({ minutes: remainingMinutes });
    }

    remainingMinutes -= availableMinutes;
    current = nextOperatingWindowStart(windowEnd, operatingHours);
  }

  // Unreachable: the loop above always returns once remainingMinutes hits zero.
  throw new Error("calculateEndDateWithOperatingHours failed to converge — this indicates a bug.");
}
