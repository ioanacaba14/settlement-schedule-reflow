import { DateTime } from "luxon";
import { buildDependencyGraph, topologicalSort } from "./dependency-graph.js";
import { makeTask } from "./test-fixtures.js";

describe("buildDependencyGraph", () => {
  it("throws a clear error for a dangling dependency id", () => {
    const a = makeTask({ docId: "a", dependsOnTaskIds: ["does-not-exist"] });
    expect(() => buildDependencyGraph([a])).toThrow(/unknown task id "does-not-exist"/);
  });
});

describe("topologicalSort", () => {
  it("orders a linear chain by dependency, not by array order", () => {
    const a = makeTask({ docId: "a", taskReference: "A", startDate: "2026-08-31T10:00:00.000Z" });
    const b = makeTask({ docId: "b", taskReference: "B", dependsOnTaskIds: ["a"], startDate: "2026-08-31T09:00:00.000Z" });
    // b is listed first and starts earlier, but depends on a, so a must come first regardless.
    const graph = buildDependencyGraph([b, a]);
    const order = topologicalSort(graph).map((t) => t.data.taskReference);
    expect(order).toEqual(["A", "B"]);
  });

  it("breaks ties among independently-ready tasks by earliest original startDate", () => {
    const late = makeTask({ docId: "late", taskReference: "LATE", startDate: "2026-08-31T12:00:00.000Z" });
    const early = makeTask({ docId: "early", taskReference: "EARLY", startDate: "2026-08-31T08:00:00.000Z" });
    const graph = buildDependencyGraph([late, early]);
    const order = topologicalSort(graph).map((t) => t.data.taskReference);
    expect(order).toEqual(["EARLY", "LATE"]);
  });

  it("resolves a diamond dependency (D waits on both B and C, which both depend on A)", () => {
    const a = makeTask({ docId: "a", taskReference: "A" });
    const b = makeTask({ docId: "b", taskReference: "B", dependsOnTaskIds: ["a"] });
    const c = makeTask({ docId: "c", taskReference: "C", dependsOnTaskIds: ["a"] });
    const d = makeTask({ docId: "d", taskReference: "D", dependsOnTaskIds: ["b", "c"] });
    const graph = buildDependencyGraph([d, c, b, a]);
    const order = topologicalSort(graph).map((t) => t.data.taskReference);

    expect(order.indexOf("A")).toBeLessThan(order.indexOf("B"));
    expect(order.indexOf("A")).toBeLessThan(order.indexOf("C"));
    expect(order.indexOf("B")).toBeLessThan(order.indexOf("D"));
    expect(order.indexOf("C")).toBeLessThan(order.indexOf("D"));
  });

  it("returns an empty order for an empty task list", () => {
    const graph = buildDependencyGraph([]);
    expect(topologicalSort(graph)).toEqual([]);
  });

  it("throws on a circular dependency via its own leftover-node fallback", () => {
    const a = makeTask({ docId: "a", taskReference: "A", dependsOnTaskIds: ["b"] });
    const b = makeTask({ docId: "b", taskReference: "B", dependsOnTaskIds: ["a"] });
    const graph = buildDependencyGraph([a, b]);
    expect(() => topologicalSort(graph)).toThrow(/Circular dependency detected/);
  });

  it("throws on a self-dependency (a 1-node cycle)", () => {
    const a = makeTask({ docId: "a", taskReference: "A", dependsOnTaskIds: ["a"] });
    const graph = buildDependencyGraph([a]);
    expect(() => topologicalSort(graph)).toThrow(/Circular dependency detected/);
  });

  it("throws on duplicate task docIds", () => {
    const a = makeTask({ docId: "dup", taskReference: "A" });
    const b = makeTask({ docId: "dup", taskReference: "B" });
    expect(() => buildDependencyGraph([a, b])).toThrow(/Duplicate task docId\(s\) found: dup/);
  });

  it("sorts 20,000 independent tasks well under a second (regression: the ready queue used to re-sort on every pop)", () => {
    const tasks = Array.from({ length: 20_000 }, (_, i) =>
      makeTask({
        docId: `t${i}`,
        taskReference: `T${i}`,
        // Reverse chronological order so the heap can't coast on already-sorted input.
        startDate: DateTime.fromISO("2026-08-31T08:00:00.000Z").plus({ minutes: 20_000 - i }).toISO()!,
      }),
    );
    const graph = buildDependencyGraph(tasks);

    const start = performance.now();
    const order = topologicalSort(graph);
    const elapsedMs = performance.now() - start;

    expect(order).toHaveLength(20_000);
    expect(order[0]?.data.taskReference).toBe("T19999"); // earliest startDate
    expect(elapsedMs).toBeLessThan(1000);
  });
});
