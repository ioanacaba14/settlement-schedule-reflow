import { ReflowService } from "./reflow.service.js";
import { makeChannel, makeTask } from "./test-fixtures.js";
import type { ReflowInput } from "./types.js";

function run(input: ReflowInput) {
  return new ReflowService().reflow(input);
}

describe("ReflowService — dependencies", () => {
  it("pushes a downstream task out to wait for a delayed upstream dependency", () => {
    const channel = makeChannel();
    const fundTransfer = makeTask({
      docId: "fund",
      taskReference: "FUND",
      startDate: "2026-08-31T10:00:00.000Z",
      endDate: "2026-08-31T11:00:00.000Z",
      durationMinutes: 60,
    });
    const disbursement = makeTask({
      docId: "disburse",
      taskReference: "DISBURSE",
      dependsOnTaskIds: ["fund"],
      startDate: "2026-08-31T08:30:00.000Z",
      endDate: "2026-08-31T09:00:00.000Z",
      durationMinutes: 30,
    });

    const result = run({ settlementTasks: [fundTransfer, disbursement], settlementChannels: [channel], tradeOrders: [] });

    const updatedDisburse = result.updatedTasks.find((t) => t.docId === "disburse")!;
    expect(updatedDisburse.data.startDate).toBe("2026-08-31T11:00:00.000Z");
    expect(updatedDisburse.data.endDate).toBe("2026-08-31T11:30:00.000Z");
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]?.reason).toMatch(/waited for an upstream dependency/);
  });

  it("waits for the LATEST of multiple upstream dependencies", () => {
    const channel = makeChannel();
    const depFast = makeTask({
      docId: "fast",
      taskReference: "FAST",
      settlementChannelId: "channel-1",
      startDate: "2026-08-31T08:00:00.000Z",
      endDate: "2026-08-31T08:30:00.000Z",
    });
    const depSlow = makeTask({
      docId: "slow",
      taskReference: "SLOW",
      settlementChannelId: "channel-2",
      startDate: "2026-08-31T09:00:00.000Z",
      endDate: "2026-08-31T10:00:00.000Z",
      durationMinutes: 60,
    });
    const downstream = makeTask({
      docId: "downstream",
      taskReference: "DOWNSTREAM",
      settlementChannelId: "channel-3",
      dependsOnTaskIds: ["fast", "slow"],
      startDate: "2026-08-31T08:30:00.000Z",
      endDate: "2026-08-31T09:00:00.000Z",
      durationMinutes: 30,
    });

    const result = run({
      settlementTasks: [depFast, depSlow, downstream],
      settlementChannels: [
        makeChannel({ docId: "channel-1" }),
        makeChannel({ docId: "channel-2" }),
        makeChannel({ docId: "channel-3" }),
      ],
      tradeOrders: [],
    });

    const updated = result.updatedTasks.find((t) => t.docId === "downstream")!;
    // Must wait for SLOW's end (10:00), not FAST's end (8:30).
    expect(updated.data.startDate).toBe("2026-08-31T10:00:00.000Z");
  });

  it("throws a clear error for a circular dependency", () => {
    const channel = makeChannel();
    const a = makeTask({ docId: "a", taskReference: "A", dependsOnTaskIds: ["b"] });
    const b = makeTask({ docId: "b", taskReference: "B", dependsOnTaskIds: ["a"] });
    expect(() => run({ settlementTasks: [a, b], settlementChannels: [channel], tradeOrders: [] })).toThrow(
      /Circular dependency detected/,
    );
  });

  it("throws a clear error for a dangling dependency id", () => {
    const channel = makeChannel();
    const a = makeTask({ docId: "a", taskReference: "A", dependsOnTaskIds: ["ghost"] });
    expect(() => run({ settlementTasks: [a], settlementChannels: [channel], tradeOrders: [] })).toThrow(
      /unknown task id "ghost"/,
    );
  });
});

describe("ReflowService — channel conflicts", () => {
  it("resolves 3-way channel contention by earliest-original-start tie-break, cascading each task past the last", () => {
    const channel = makeChannel();
    const first = makeTask({
      docId: "first",
      taskReference: "FIRST",
      startDate: "2026-08-31T09:00:00.000Z",
      endDate: "2026-08-31T09:20:00.000Z",
      durationMinutes: 20,
    });
    const second = makeTask({
      docId: "second",
      taskReference: "SECOND",
      startDate: "2026-08-31T09:10:00.000Z",
      endDate: "2026-08-31T09:40:00.000Z",
      durationMinutes: 30,
    });
    const third = makeTask({
      docId: "third",
      taskReference: "THIRD",
      startDate: "2026-08-31T09:15:00.000Z",
      endDate: "2026-08-31T09:30:00.000Z",
      durationMinutes: 15,
    });

    const result = run({ settlementTasks: [third, second, first], settlementChannels: [channel], tradeOrders: [] });
    const byRef = Object.fromEntries(result.updatedTasks.map((t) => [t.data.taskReference, t.data]));

    expect(byRef.FIRST?.startDate).toBe("2026-08-31T09:00:00.000Z"); // unchanged, earliest original start wins
    expect(byRef.SECOND?.startDate).toBe("2026-08-31T09:20:00.000Z"); // pushed past FIRST
    expect(byRef.THIRD?.startDate).toBe("2026-08-31T09:50:00.000Z"); // pushed past SECOND's new slot
  });

  it("does not flag or move tasks on different channels even if their times overlap", () => {
    const channelA = makeChannel({ docId: "ch-a" });
    const channelB = makeChannel({ docId: "ch-b" });
    const a = makeTask({
      docId: "a",
      taskReference: "A",
      settlementChannelId: "ch-a",
      startDate: "2026-08-31T09:00:00.000Z",
      endDate: "2026-08-31T09:30:00.000Z",
    });
    const b = makeTask({
      docId: "b",
      taskReference: "B",
      settlementChannelId: "ch-b",
      startDate: "2026-08-31T09:00:00.000Z",
      endDate: "2026-08-31T09:30:00.000Z",
    });

    const result = run({ settlementTasks: [a, b], settlementChannels: [channelA, channelB], tradeOrders: [] });
    expect(result.changes).toHaveLength(0);
  });

  it("throws for a task referencing an unknown settlement channel id", () => {
    const a = makeTask({ docId: "a", taskReference: "A", settlementChannelId: "ghost-channel" });
    expect(() => run({ settlementTasks: [a], settlementChannels: [], tradeOrders: [] })).toThrow(
      /unknown settlement channel id "ghost-channel"/,
    );
  });

  it("throws for a regulatory hold referencing an unknown settlement channel id (regression: holds used to skip this check)", () => {
    const hold = makeTask({
      docId: "hold",
      taskReference: "HOLD",
      isRegulatoryHold: true,
      settlementChannelId: "ghost-channel",
    });
    expect(() => run({ settlementTasks: [hold], settlementChannels: [], tradeOrders: [] })).toThrow(
      /unknown settlement channel id "ghost-channel"/,
    );
  });

  it("throws on duplicate channel docIds", () => {
    const channelA = makeChannel({ docId: "dup" });
    const channelB = makeChannel({ docId: "dup" });
    expect(() => run({ settlementTasks: [], settlementChannels: [channelA, channelB], tradeOrders: [] })).toThrow(
      /Duplicate channel docId\(s\) found: dup/,
    );
  });

  it("resolves heavy contention (1,500 tasks wanting the exact same instant) without exceeding the old fixed iteration cap", () => {
    // Regression: MAX_PLACEMENT_ITERATIONS used to be a flat 1000, so the
    // ~1499th task here (needing that many sequential jumps past everyone
    // ahead of it) would have thrown a false "no available slot" error.
    const channel = makeChannel({
      operatingHours: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, startHour: 0, endHour: 23 })),
    });
    const tasks = Array.from({ length: 1500 }, (_, i) =>
      makeTask({
        docId: `t${i}`,
        taskReference: `T${String(i).padStart(4, "0")}`,
        startDate: "2026-08-31T00:00:00.000Z",
        endDate: "2026-08-31T00:01:00.000Z",
        durationMinutes: 1,
      }),
    );

    const started = performance.now();
    const result = run({ settlementTasks: tasks, settlementChannels: [channel], tradeOrders: [] });
    const elapsedMs = performance.now() - started;

    expect(result.updatedTasks).toHaveLength(1500);
    expect(elapsedMs).toBeLessThan(2000);

    const byRef = Object.fromEntries(result.updatedTasks.map((t) => [t.data.taskReference, t.data]));
    expect(byRef.T0000?.startDate).toBe("2026-08-31T00:00:00.000Z"); // earliest reference wins the contested instant
    expect(byRef.T0001?.startDate).toBe("2026-08-31T00:01:00.000Z"); // next one pushed by exactly 1 minute
  });
});

describe("ReflowService — regulatory holds", () => {
  it("never moves a regulatory hold, and reports it as unchanged", () => {
    const channel = makeChannel();
    const hold = makeTask({
      docId: "hold",
      taskReference: "HOLD",
      isRegulatoryHold: true,
      taskType: "regulatoryHold",
      startDate: "2026-08-31T11:00:00.000Z",
      endDate: "2026-08-31T11:20:00.000Z",
    });

    const result = run({ settlementTasks: [hold], settlementChannels: [channel], tradeOrders: [] });
    expect(result.updatedTasks[0]?.data.startDate).toBe("2026-08-31T11:00:00.000Z");
    expect(result.changes).toHaveLength(0);
  });

  it("routes a movable task around a regulatory hold sitting in its path", () => {
    const channel = makeChannel();
    const hold = makeTask({
      docId: "hold",
      taskReference: "HOLD",
      isRegulatoryHold: true,
      taskType: "regulatoryHold",
      startDate: "2026-08-31T09:00:00.000Z",
      endDate: "2026-08-31T09:20:00.000Z",
    });
    const movable = makeTask({
      docId: "movable",
      taskReference: "MOVABLE",
      startDate: "2026-08-31T09:00:00.000Z",
      endDate: "2026-08-31T09:30:00.000Z",
      durationMinutes: 30,
    });

    const result = run({ settlementTasks: [hold, movable], settlementChannels: [channel], tradeOrders: [] });
    const updated = result.updatedTasks.find((t) => t.docId === "movable")!;
    expect(updated.data.startDate).toBe("2026-08-31T09:20:00.000Z");
    expect(result.changes[0]?.reason).toMatch(/scheduling conflict with HOLD/);
  });

  it("throws when two regulatory holds overlap on the same channel", () => {
    const channel = makeChannel();
    const holdA = makeTask({
      docId: "a",
      taskReference: "HOLD-A",
      isRegulatoryHold: true,
      startDate: "2026-08-31T09:00:00.000Z",
      endDate: "2026-08-31T09:30:00.000Z",
    });
    const holdB = makeTask({
      docId: "b",
      taskReference: "HOLD-B",
      isRegulatoryHold: true,
      startDate: "2026-08-31T09:15:00.000Z",
      endDate: "2026-08-31T09:45:00.000Z",
    });
    expect(() => run({ settlementTasks: [holdA, holdB], settlementChannels: [channel], tradeOrders: [] })).toThrow(
      /HOLD-B.*overlaps with HOLD-A/,
    );
  });

  it("throws when a regulatory hold depends on another hold whose fixed end is after its own fixed start", () => {
    const channel = makeChannel();
    const upstreamHold = makeTask({
      docId: "upstream-hold",
      taskReference: "UPSTREAM-HOLD",
      isRegulatoryHold: true,
      startDate: "2026-08-31T11:00:00.000Z",
      endDate: "2026-08-31T11:30:00.000Z",
    });
    const downstreamHold = makeTask({
      docId: "downstream-hold",
      taskReference: "DOWNSTREAM-HOLD",
      isRegulatoryHold: true,
      dependsOnTaskIds: ["upstream-hold"],
      startDate: "2026-08-31T10:00:00.000Z",
      endDate: "2026-08-31T10:30:00.000Z",
    });
    expect(() =>
      run({ settlementTasks: [upstreamHold, downstreamHold], settlementChannels: [channel], tradeOrders: [] }),
    ).toThrow(/DOWNSTREAM-HOLD cannot be rescheduled/);
  });

  it("throws when a regulatory hold's dependency can't finish before its fixed start", () => {
    const channel = makeChannel();
    const upstream = makeTask({
      docId: "upstream",
      taskReference: "UPSTREAM",
      startDate: "2026-08-31T10:00:00.000Z",
      endDate: "2026-08-31T11:00:00.000Z",
      durationMinutes: 60,
    });
    const hold = makeTask({
      docId: "hold",
      taskReference: "HOLD",
      isRegulatoryHold: true,
      dependsOnTaskIds: ["upstream"],
      startDate: "2026-08-31T10:30:00.000Z",
      endDate: "2026-08-31T10:45:00.000Z",
    });
    expect(() => run({ settlementTasks: [upstream, hold], settlementChannels: [channel], tradeOrders: [] })).toThrow(
      /HOLD cannot be rescheduled/,
    );
  });

  it("does not require a regulatory hold's fixed window to fall within operating hours", () => {
    const channel = makeChannel(); // Mon-Fri 8-16
    const hold = makeTask({
      docId: "hold",
      taskReference: "HOLD",
      isRegulatoryHold: true,
      startDate: "2026-08-31T22:00:00.000Z", // well outside 8-16
      endDate: "2026-08-31T22:30:00.000Z",
    });
    const result = run({ settlementTasks: [hold], settlementChannels: [channel], tradeOrders: [] });
    expect(result.updatedTasks[0]?.data.startDate).toBe("2026-08-31T22:00:00.000Z");
  });
});

describe("ReflowService — operating hours", () => {
  it("matches the spec's worked example end to end", () => {
    const channel = makeChannel();
    const task = makeTask({
      docId: "t",
      taskReference: "T",
      startDate: "2026-08-31T15:00:00.000Z",
      endDate: "2026-08-31T17:00:00.000Z",
      durationMinutes: 120,
    });
    const result = run({ settlementTasks: [task], settlementChannels: [channel], tradeOrders: [] });
    const updated = result.updatedTasks[0]!;
    expect(updated.data.startDate).toBe("2026-08-31T15:00:00.000Z");
    expect(updated.data.endDate).toBe("2026-09-01T09:00:00.000Z");
    expect(result.changes[0]?.reason).toMatch(/did not fit before the channel closed/);
  });

  it("snaps a task starting outside operating hours to the next window", () => {
    const channel = makeChannel();
    const task = makeTask({
      docId: "t",
      taskReference: "T",
      startDate: "2026-08-31T20:00:00.000Z",
      endDate: "2026-08-31T20:30:00.000Z",
      durationMinutes: 30,
    });
    const result = run({ settlementTasks: [task], settlementChannels: [channel], tradeOrders: [] });
    const updated = result.updatedTasks[0]!;
    expect(updated.data.startDate).toBe("2026-09-01T08:00:00.000Z");
    expect(result.changes[0]?.reason).toMatch(/fell outside the channel's operating hours/);
  });
});

describe("ReflowService — blackout windows", () => {
  it("routes a task around a blackout window, cascading to its dependent", () => {
    const channel = makeChannel({
      blackoutWindows: [{ startDate: "2026-08-31T10:00:00.000Z", endDate: "2026-08-31T11:00:00.000Z", reason: "Maintenance" }],
    });
    const margin = makeTask({
      docId: "margin",
      taskReference: "MARGIN",
      startDate: "2026-08-31T10:00:00.000Z",
      endDate: "2026-08-31T10:30:00.000Z",
      durationMinutes: 30,
    });
    const fundTransfer = makeTask({
      docId: "fund",
      taskReference: "FUND",
      dependsOnTaskIds: ["margin"],
      startDate: "2026-08-31T10:30:00.000Z",
      endDate: "2026-08-31T11:00:00.000Z",
      durationMinutes: 30,
    });

    const result = run({ settlementTasks: [margin, fundTransfer], settlementChannels: [channel], tradeOrders: [] });
    const byRef = Object.fromEntries(result.updatedTasks.map((t) => [t.data.taskReference, t.data]));

    expect(byRef.MARGIN?.startDate).toBe("2026-08-31T11:00:00.000Z");
    expect(byRef.FUND?.startDate).toBe("2026-08-31T11:30:00.000Z");
  });

  it("throws when a regulatory hold overlaps a blackout window", () => {
    const channel = makeChannel({
      blackoutWindows: [{ startDate: "2026-08-31T09:00:00.000Z", endDate: "2026-08-31T11:00:00.000Z", reason: "Maintenance" }],
    });
    const hold = makeTask({
      docId: "hold",
      taskReference: "HOLD",
      isRegulatoryHold: true,
      startDate: "2026-08-31T10:00:00.000Z",
      endDate: "2026-08-31T10:30:00.000Z",
    });
    expect(() => run({ settlementTasks: [hold], settlementChannels: [channel], tradeOrders: [] })).toThrow(
      /HOLD overlaps with Blackout \(Maintenance\)/,
    );
  });

  it("blames the blackout window it actually overlaps, not an unrelated touching one (regression)", () => {
    // HOLD (09:05-09:07) only overlaps blackout A (09:00-09:10); the two
    // blackouts merely touch at 09:10, they don't overlap each other or HOLD
    // together. The error must name A, not B.
    const channel = makeChannel({
      blackoutWindows: [
        { startDate: "2026-08-31T09:00:00.000Z", endDate: "2026-08-31T09:10:00.000Z", reason: "A" },
        { startDate: "2026-08-31T09:10:00.000Z", endDate: "2026-08-31T09:20:00.000Z", reason: "B" },
      ],
    });
    const hold = makeTask({
      docId: "hold",
      taskReference: "HOLD",
      isRegulatoryHold: true,
      startDate: "2026-08-31T09:05:00.000Z",
      endDate: "2026-08-31T09:07:00.000Z",
    });
    expect(() => run({ settlementTasks: [hold], settlementChannels: [channel], tradeOrders: [] })).toThrow(
      /HOLD overlaps with Blackout \(A\)/,
    );
  });

  it("throws when two blackout windows on the same channel overlap (invalid config)", () => {
    const channel = makeChannel({
      blackoutWindows: [
        { startDate: "2026-08-31T09:00:00.000Z", endDate: "2026-08-31T11:00:00.000Z", reason: "A" },
        { startDate: "2026-08-31T10:00:00.000Z", endDate: "2026-08-31T12:00:00.000Z", reason: "B" },
      ],
    });
    expect(() => run({ settlementTasks: [], settlementChannels: [channel], tradeOrders: [] })).toThrow(
      /configuration is invalid/,
    );
  });
});

describe("ReflowService — general behavior", () => {
  it("returns an empty result for an empty task list without throwing", () => {
    const result = run({ settlementTasks: [], settlementChannels: [makeChannel()], tradeOrders: [] });
    expect(result).toEqual({
      updatedTasks: [],
      changes: [],
      explanation: ["No changes needed — the existing schedule already satisfies all dependencies and channel constraints."],
    });
  });

  it("reports no changes when the input schedule is already valid", () => {
    const channel = makeChannel();
    const task = makeTask({
      docId: "t",
      taskReference: "T",
      startDate: "2026-08-31T08:00:00.000Z",
      endDate: "2026-08-31T08:30:00.000Z",
    });
    const result = run({ settlementTasks: [task], settlementChannels: [channel], tradeOrders: [] });
    expect(result.changes).toEqual([]);
    expect(result.explanation).toEqual([
      "No changes needed — the existing schedule already satisfies all dependencies and channel constraints.",
    ]);
  });

  it("preserves the original task array order in updatedTasks regardless of processing order", () => {
    const channel = makeChannel();
    const b = makeTask({ docId: "b", taskReference: "B", startDate: "2026-08-31T09:00:00.000Z" });
    const a = makeTask({ docId: "a", taskReference: "A", dependsOnTaskIds: ["b"], startDate: "2026-08-31T09:30:00.000Z" });
    // Input order is [a, b], even though b must be *processed* first.
    const result = run({ settlementTasks: [a, b], settlementChannels: [channel], tradeOrders: [] });
    expect(result.updatedTasks.map((t) => t.docId)).toEqual(["a", "b"]);
  });
});
