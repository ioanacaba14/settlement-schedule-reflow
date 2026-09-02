import type { OperatingHoursWindow, SettlementChannel, SettlementTask } from "./types.js";

/** Not itself a test file — shared builders so every test isn't hand-rolling documents. */

let taskCounter = 0;

/** 2026-08-31 is a Monday; all fixture dates anchor off that week unless overridden. */
export function makeTask(overrides: Partial<SettlementTask["data"]> & { docId?: string } = {}): SettlementTask {
  taskCounter += 1;
  const { docId, ...dataOverrides } = overrides;
  return {
    docId: docId ?? `task-${taskCounter}`,
    docType: "settlementTask",
    data: {
      taskReference: `STL-${taskCounter}`,
      tradeOrderId: "trade-1",
      settlementChannelId: "channel-1",
      startDate: "2026-08-31T08:00:00.000Z",
      endDate: "2026-08-31T08:30:00.000Z",
      durationMinutes: 30,
      isRegulatoryHold: false,
      dependsOnTaskIds: [],
      taskType: "marginCheck",
      ...dataOverrides,
    },
  };
}

export function makeChannel(overrides: Partial<SettlementChannel["data"]> & { docId?: string } = {}): SettlementChannel {
  const { docId, ...dataOverrides } = overrides;
  return {
    docId: docId ?? "channel-1",
    docType: "settlementChannel",
    data: {
      name: "Test Channel",
      operatingHours: MON_FRI_8_16,
      blackoutWindows: [],
      ...dataOverrides,
    },
  };
}

export const MON_FRI_8_16: OperatingHoursWindow[] = [1, 2, 3, 4, 5].map((dayOfWeek) => ({
  dayOfWeek,
  startHour: 8,
  endHour: 16,
}));
