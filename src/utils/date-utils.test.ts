import { DateTime } from "luxon";
import {
  calculateEndDateWithOperatingHours,
  isWithinOperatingHours,
  nextOperatingInstant,
  nextOperatingWindowStart,
} from "./date-utils.js";
import { MON_FRI_8_16 } from "../reflow/test-fixtures.js";

const utc = (iso: string) => DateTime.fromISO(iso, { zone: "utc" });

describe("calculateEndDateWithOperatingHours", () => {
  it("matches the spec's worked example: 120min @ Mon 3PM pauses and resumes Tue 8AM", () => {
    // 2026-08-31 is a Monday.
    const end = calculateEndDateWithOperatingHours(utc("2026-08-31T15:00:00.000Z"), 120, MON_FRI_8_16);
    expect(end.toUTC().toISO()).toBe("2026-09-01T09:00:00.000Z");
  });

  it("fits entirely within one window", () => {
    const end = calculateEndDateWithOperatingHours(utc("2026-08-31T08:00:00.000Z"), 30, MON_FRI_8_16);
    expect(end.toUTC().toISO()).toBe("2026-08-31T08:30:00.000Z");
  });

  it("snaps a start outside operating hours to the next window", () => {
    const end = calculateEndDateWithOperatingHours(utc("2026-08-31T18:00:00.000Z"), 30, MON_FRI_8_16);
    expect(end.toUTC().toISO()).toBe("2026-09-01T08:30:00.000Z");
  });

  it("skips a weekend gap with no operating window", () => {
    // 2026-09-04 is a Friday.
    const end = calculateEndDateWithOperatingHours(utc("2026-09-04T15:30:00.000Z"), 90, MON_FRI_8_16);
    expect(end.toUTC().toISO()).toBe("2026-09-07T09:00:00.000Z");
  });

  it("spans multiple full days", () => {
    // 8h/day window; 1020min = 2 full days (960min) + 60min into day 3.
    const end = calculateEndDateWithOperatingHours(utc("2026-08-31T08:00:00.000Z"), 1020, MON_FRI_8_16);
    expect(end.toUTC().toISO()).toBe("2026-09-02T09:00:00.000Z");
  });

  it("completes instantly for a zero-duration task (regression: used to throw)", () => {
    const end = calculateEndDateWithOperatingHours(utc("2026-08-31T10:00:00.000Z"), 0, MON_FRI_8_16);
    expect(end.toUTC().toISO()).toBe("2026-08-31T10:00:00.000Z");
  });

  it("a zero-duration task starting outside hours still snaps forward before completing", () => {
    const end = calculateEndDateWithOperatingHours(utc("2026-08-31T18:00:00.000Z"), 0, MON_FRI_8_16);
    expect(end.toUTC().toISO()).toBe("2026-09-01T08:00:00.000Z");
  });

  it("rejects a negative duration", () => {
    expect(() => calculateEndDateWithOperatingHours(utc("2026-08-31T08:00:00.000Z"), -5, MON_FRI_8_16)).toThrow(
      /non-negative/,
    );
  });

  it("rejects a window where startHour >= endHour (regression: used to throw a confusing error deep inside placement)", () => {
    const badWindow = [{ dayOfWeek: 1, startHour: 16, endHour: 8 }];
    expect(() => calculateEndDateWithOperatingHours(utc("2026-08-31T10:00:00.000Z"), 30, badWindow)).toThrow(
      /startHour .* must be before endHour/,
    );
  });

  it("rejects two overlapping windows on the same day (regression: used to silently jump a week ahead instead of using the wider window)", () => {
    const overlapping = [
      { dayOfWeek: 1, startHour: 8, endHour: 16 },
      { dayOfWeek: 1, startHour: 10, endHour: 18 },
    ];
    expect(() => calculateEndDateWithOperatingHours(utc("2026-08-31T11:00:00.000Z"), 360, overlapping)).toThrow(
      /two windows for dayOfWeek 1 overlap/,
    );
  });

  it("allows two non-overlapping windows on the same day (e.g. a lunch-break split)", () => {
    const splitDay = [
      { dayOfWeek: 1, startHour: 8, endHour: 12 },
      { dayOfWeek: 1, startHour: 13, endHour: 17 },
    ];
    const end = calculateEndDateWithOperatingHours(utc("2026-08-31T11:00:00.000Z"), 120, splitDay);
    // 60 min left in the morning window (11-12), pauses over lunch, resumes 13:00, needs 60 more -> 14:00.
    expect(end.toUTC().toISO()).toBe("2026-08-31T14:00:00.000Z");
  });

  it("rejects an out-of-range dayOfWeek", () => {
    const badWindow = [{ dayOfWeek: 7, startHour: 8, endHour: 16 }];
    expect(() => calculateEndDateWithOperatingHours(utc("2026-08-31T10:00:00.000Z"), 30, badWindow)).toThrow(
      /dayOfWeek must be an integer 0-6/,
    );
  });

  it("rejects an out-of-range hour", () => {
    const badWindow = [{ dayOfWeek: 1, startHour: 8, endHour: 24 }];
    expect(() => calculateEndDateWithOperatingHours(utc("2026-08-31T10:00:00.000Z"), 30, badWindow)).toThrow(
      /startHour\/endHour must be integers 0-23/,
    );
  });
});

describe("isWithinOperatingHours", () => {
  it("excludes the instant exactly at close (half-open window)", () => {
    expect(isWithinOperatingHours(utc("2026-08-31T16:00:00.000Z"), MON_FRI_8_16)).toBe(false);
  });

  it("includes the instant exactly at open", () => {
    expect(isWithinOperatingHours(utc("2026-08-31T08:00:00.000Z"), MON_FRI_8_16)).toBe(true);
  });

  it("excludes a weekend day with no window entry", () => {
    // 2026-09-05 is a Saturday.
    expect(isWithinOperatingHours(utc("2026-09-05T10:00:00.000Z"), MON_FRI_8_16)).toBe(false);
  });
});

describe("nextOperatingInstant", () => {
  it("returns an already-valid instant unchanged", () => {
    const instant = utc("2026-08-31T10:00:00.000Z");
    expect(nextOperatingInstant(instant, MON_FRI_8_16).toUTC().toISO()).toBe(instant.toUTC().toISO());
  });
});

describe("nextOperatingWindowStart", () => {
  it("throws for a channel with no operating hours at all", () => {
    expect(() => nextOperatingWindowStart(utc("2026-08-31T10:00:00.000Z"), [])).toThrow(/no operating hours defined/);
  });

  // The "exceeds the 14-day scan horizon" branch has no reachable test case:
  // any single valid weekly window (dayOfWeek 0-6) recurs within 7 days, so a
  // validated config can never actually exhaust a 14-day scan.
});
