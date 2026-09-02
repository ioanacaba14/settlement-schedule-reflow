import { DateTime } from "luxon";
import { MinHeap } from "./min-heap.js";
import type { SettlementTask } from "./types.js";

export interface DependencyGraph {
  tasksById: Map<string, SettlementTask>;
  /** taskId -> ids of tasks that list it in their dependsOnTaskIds. */
  dependents: Map<string, string[]>;
}

/**
 * Parses dependsOnTaskIds into an adjacency structure and validates that
 * every referenced id actually exists. Throws early with a precise error
 * rather than letting a dangling reference surface later as a confusing
 * "dependency never completes" failure.
 */
export function buildDependencyGraph(tasks: SettlementTask[]): DependencyGraph {
  const tasksById = new Map(tasks.map((task) => [task.docId, task]));
  if (tasksById.size !== tasks.length) {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const task of tasks) {
      if (seen.has(task.docId)) duplicates.add(task.docId);
      seen.add(task.docId);
    }
    throw new Error(`Duplicate task docId(s) found: ${[...duplicates].join(", ")} — task ids must be unique.`);
  }

  const dependents = new Map<string, string[]>();

  for (const task of tasks) {
    for (const depId of task.data.dependsOnTaskIds) {
      if (!tasksById.has(depId)) {
        throw new Error(
          `Task ${task.data.taskReference} depends on unknown task id "${depId}" — cannot compute a valid schedule.`,
        );
      }
      const list = dependents.get(depId) ?? [];
      list.push(task.docId);
      dependents.set(depId, list);
    }
  }

  return { tasksById, dependents };
}

/**
 * Kahn's algorithm (BFS layering by in-degree): repeatedly processes tasks
 * whose dependencies are all already ordered. Among tasks that become
 * eligible at the same time, the one with the earliest original startDate is
 * processed first — this is what implements the "earliest original start
 * wins" channel-contention tie-break rule, since processing order is exactly
 * the order tasks get to claim a channel slot in.
 *
 * The ready queue is a proper binary heap, not a re-sorted array: at 1M+
 * tasks, re-sorting the whole ready queue on every pop turns an O(n log n)
 * algorithm into an accidental O(n^2 log n) one. Each task's startDate is
 * also parsed to millis exactly once up front rather than on every heap
 * comparison.
 */
export function topologicalSort(graph: DependencyGraph): SettlementTask[] {
  const inDegree = new Map<string, number>();
  const startMillisById = new Map<string, number>();
  for (const task of graph.tasksById.values()) {
    inDegree.set(task.docId, task.data.dependsOnTaskIds.length);
    startMillisById.set(task.docId, DateTime.fromISO(task.data.startDate).toMillis());
  }

  const byStartThenReference = (a: SettlementTask, b: SettlementTask): number => {
    const byStart = startMillisById.get(a.docId)! - startMillisById.get(b.docId)!;
    return byStart !== 0 ? byStart : a.data.taskReference.localeCompare(b.data.taskReference);
  };

  const ready = new MinHeap<SettlementTask>(byStartThenReference);
  for (const task of graph.tasksById.values()) {
    if (inDegree.get(task.docId) === 0) ready.push(task);
  }

  const ordered: SettlementTask[] = [];
  let next: SettlementTask | undefined;
  while ((next = ready.pop()) !== undefined) {
    ordered.push(next);

    for (const dependentId of graph.dependents.get(next.docId) ?? []) {
      const remaining = (inDegree.get(dependentId) ?? 0) - 1;
      inDegree.set(dependentId, remaining);
      if (remaining === 0) {
        ready.push(graph.tasksById.get(dependentId)!);
      }
    }
  }

  if (ordered.length < graph.tasksById.size) {
    const stuck = [...graph.tasksById.values()]
      .filter((task) => (inDegree.get(task.docId) ?? 0) > 0)
      .map((task) => task.data.taskReference);
    throw new Error(`Circular dependency detected among tasks: ${stuck.join(", ")}`);
  }

  return ordered;
}
