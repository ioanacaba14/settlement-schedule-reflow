import { validateSchedule } from "./constraint-checker.js";
import { makeChannel, makeTask } from "./test-fixtures.js";

describe("validateSchedule", () => {
  it("is valid for a schedule with no conflicts, satisfied dependencies, and no blackout overlap", () => {
    const channel = makeChannel();
    const a = makeTask({ docId: "a", taskReference: "A", startDate: "2026-08-31T08:00:00.000Z", endDate: "2026-08-31T08:30:00.000Z" });
    const b = makeTask({
      docId: "b",
      taskReference: "B",
      dependsOnTaskIds: ["a"],
      startDate: "2026-08-31T08:30:00.000Z",
      endDate: "2026-08-31T09:00:00.000Z",
    });
    const result = validateSchedule([a, b], [channel]);
    expect(result).toEqual({ valid: true, issues: [] });
  });

  it("flags two tasks overlapping on the same channel", () => {
    const channel = makeChannel();
    const a = makeTask({ docId: "a", taskReference: "A", startDate: "2026-08-31T08:00:00.000Z", endDate: "2026-08-31T09:00:00.000Z" });
    const b = makeTask({ docId: "b", taskReference: "B", startDate: "2026-08-31T08:30:00.000Z", endDate: "2026-08-31T09:00:00.000Z" });
    const result = validateSchedule([a, b], [channel]);
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.message).toMatch(/Overlaps with task A/);
  });

  it("does not flag identical overlapping times on two different channels", () => {
    const channelA = makeChannel({ docId: "ch-a" });
    const channelB = makeChannel({ docId: "ch-b" });
    const a = makeTask({
      docId: "a",
      taskReference: "A",
      settlementChannelId: "ch-a",
      startDate: "2026-08-31T08:00:00.000Z",
      endDate: "2026-08-31T09:00:00.000Z",
    });
    const b = makeTask({
      docId: "b",
      taskReference: "B",
      settlementChannelId: "ch-b",
      startDate: "2026-08-31T08:00:00.000Z",
      endDate: "2026-08-31T09:00:00.000Z",
    });
    const result = validateSchedule([a, b], [channelA, channelB]);
    expect(result).toEqual({ valid: true, issues: [] });
  });

  it("flags a task starting before its dependency completes", () => {
    // On different channels so this isolates the dependency violation from the channel-conflict check.
    const channelA = makeChannel({ docId: "ch-a" });
    const channelB = makeChannel({ docId: "ch-b" });
    const a = makeTask({
      docId: "a",
      taskReference: "A",
      settlementChannelId: "ch-a",
      startDate: "2026-08-31T08:00:00.000Z",
      endDate: "2026-08-31T09:00:00.000Z",
    });
    const b = makeTask({
      docId: "b",
      taskReference: "B",
      settlementChannelId: "ch-b",
      dependsOnTaskIds: ["a"],
      startDate: "2026-08-31T08:30:00.000Z",
      endDate: "2026-08-31T09:00:00.000Z",
    });
    const result = validateSchedule([a, b], [channelA, channelB]);
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.message).toMatch(/Starts before dependency A completes/);
  });

  it("flags a dependency on an unknown task id", () => {
    const channel = makeChannel();
    const a = makeTask({ docId: "a", taskReference: "A", dependsOnTaskIds: ["ghost"] });
    const result = validateSchedule([a], [channel]);
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.message).toMatch(/unknown task id "ghost"/);
  });

  it("flags a task overlapping its channel's blackout window", () => {
    const channel = makeChannel({
      blackoutWindows: [{ startDate: "2026-08-31T08:00:00.000Z", endDate: "2026-08-31T09:00:00.000Z", reason: "Maintenance" }],
    });
    const a = makeTask({ docId: "a", taskReference: "A", startDate: "2026-08-31T08:15:00.000Z", endDate: "2026-08-31T08:45:00.000Z" });
    const result = validateSchedule([a], [channel]);
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.message).toMatch(/Overlaps blackout window.*Maintenance/);
  });

  it("does not flag a task that lands right after a blackout closes", () => {
    const channel = makeChannel({
      blackoutWindows: [{ startDate: "2026-08-31T08:00:00.000Z", endDate: "2026-08-31T09:00:00.000Z" }],
    });
    const a = makeTask({ docId: "a", taskReference: "A", startDate: "2026-08-31T09:00:00.000Z", endDate: "2026-08-31T09:30:00.000Z" });
    const result = validateSchedule([a], [channel]);
    expect(result).toEqual({ valid: true, issues: [] });
  });
});
