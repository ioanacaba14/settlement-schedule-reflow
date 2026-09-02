# Settlement Schedule Reflow

A settlement schedule reflow engine for a financial operations platform: given a set of settlement tasks, settlement channels, and a disruption (a delayed trade, a channel outage, a regulatory hold), it recomputes a valid schedule that respects task dependencies, channel exclusivity, market operating hours, and blackout/maintenance windows — and explains exactly what moved and why.

Built for the Capital33 technical test.

## Setup

Requires Node.js 20+ (developed against Node 26) and npm.

```bash
npm install
```

## How to run

```bash
npm run dev        # runs all 5 sample scenarios, writes one CSV per scenario to output/
npm test            # runs the Jest test suite (55 tests)
npm run typecheck    # tsc --noEmit
npm run build        # compiles to dist/
```

`npm run dev` loads every `*.json` file in `src/data/scenarios/`, runs the reflow algorithm on each, prints a one-line summary per scenario to the console, and writes a full before/after CSV to `output/<scenario>.csv` (one row per task: original start/end, new start/end, minutes moved, and the reason).

## Algorithm approach

### Data model

Every document follows the `{ docId, docType, data }` shape from the spec. The core types (`src/reflow/types.ts`) are `SettlementTask`, `SettlementChannel` (with `operatingHours` and `blackoutWindows`), and `TradeOrder`. The reflow entry point is `ReflowService.reflow({ settlementTasks, settlementChannels, tradeOrders })`, returning `{ updatedTasks, changes, explanation }`.

### 1. Dependency ordering (the DAG)

`src/reflow/dependency-graph.ts` parses `dependsOnTaskIds` into an adjacency structure (`buildDependencyGraph`, which also fails fast on a dangling dependency id or a duplicate task `docId`) and produces a processing order via **Kahn's algorithm** (`topologicalSort`): repeatedly pull tasks whose dependencies have all already been ordered. If dependencies form a cycle, some tasks never become eligible and are reported by name in the error ("Circular dependency detected among tasks: ..."). The ready queue is a binary min-heap (`src/reflow/min-heap.ts`), not a re-sorted array — see [Performance at scale](#performance-at-scale) for why that distinction matters well before 1M tasks.

The tie-break for tasks that become eligible at the same time is deliberate: **the one with the earliest original `startDate` is processed first**. This is what actually implements "earliest original start wins" for channel contention later — processing order *is* the order in which tasks get first claim on a channel slot, so getting the tie-break right here is what makes the whole schedule deterministic and explainable.

### 2. Immovable time is staked out first

Two things on a channel cannot move: **regulatory holds** (`isRegulatoryHold: true`) and **blackout windows** (maintenance/regulatory blocks declared on the channel itself). Both are registered into a per-channel "busy interval" list (`ChannelAvailability`, in `src/reflow/channel-availability.ts`) *before* any movable task is placed, so every movable task routes around them regardless of processing order. A blackout is treated as just another occupied interval with no owning task (reported as `Blackout (reason)` wherever a task reference would normally appear) — this is a deliberate reuse of the exact same mechanism a regulatory hold or another task's booking uses, rather than a separate check, because from the placement search's point of view "channel is unavailable" has one shape no matter *why* it's unavailable.

Registering a hold checks it against whatever's already booked, so a hold that lands on top of another hold, or on top of a blackout, throws immediately with a clear "no valid schedule exists" error rather than silently overlapping.

### 3. Operating hours — the pause/resume calculator

Operating hours are structurally different from blackout windows: they're a *recurring weekly rule* (`{ dayOfWeek, startHour, endHour }`, repeating forever), not a finite list of dates, so they can't be pre-expanded into a busy-interval list the way blackouts can. `src/utils/date-utils.ts` handles this with its own small set of functions:

- `isWithinOperatingHours` / `nextOperatingWindowStart` / `nextOperatingInstant` — is an instant inside a window, and if not, when's the next one (scanning forward day by day, so weekends or off-days with no window entry are skipped naturally).
- `calculateEndDateWithOperatingHours(start, durationMinutes, operatingHours)` — the actual pause/resume accumulator: consumes `durationMinutes` of *operating* time, pausing at each window's close and resuming at the next window's open. This is verified against the spec's own worked example (a 120-minute task starting Monday 3PM on an 8AM–4PM channel processes 60 minutes, pauses overnight, resumes Tuesday 8AM, completes 9AM).

All `dayOfWeek`/`startHour`/`endHour` values are interpreted in **UTC**, and windows are half-open `[startHour, endHour)` — an instant exactly at close is already outside the window.

### 4. Placement: where operating hours and channel-busy time meet

`findEarliestAvailableSlot` (in `src/reflow/channel-availability.ts`) is the function that actually places a movable task. It alternates between two checks until both hold simultaneously:

1. Snap the candidate start into a valid operating window (via `nextOperatingInstant`).
2. Check the resulting `[start, end)` against the channel's busy-interval list (other tasks, holds, blackouts) via `ChannelAvailability.findConflict`; if it overlaps, jump past the conflicting run and go back to step 1.

These two constraints genuinely interact — jumping past a channel conflict can land outside operating hours, and snapping into the next window can land inside another booked interval — so a single pass over just one of them isn't sufficient; the loop only returns once a candidate satisfies both at once. `findConflict` doesn't just return the *one* booking nearest the candidate — it merges an entire contiguous run of touching/overlapping bookings into a single answer in one pass, which is the difference between one loop iteration and hundreds when a channel is heavily booked (see [Performance at scale](#performance-at-scale)).

For each movable task, the earliest it's *allowed* to start is `max(its own recorded startDate, the latest end time among all its dependencies)`. That floor is then run through the placement search above.

### 5. Explaining what changed

For every task whose start or end actually differs from what was recorded, a `ScheduleChange` is emitted with the delta (in minutes) and a composed reason describing which of up to four causes applied: waited for a dependency, shifted to avoid a conflict (with a task, hold, or blackout), snapped forward because its requested start was outside operating hours, and/or paused mid-processing because its duration didn't fit before the channel closed. All four are independent and can combine (see the "Complex Multi-Constraint" scenario below, where a single task's move is explained by two of them at once).

A task whose *end* changes while its *start* stays put (duration spilling past close) still counts as a change — this was a real bug caught while writing tests: change-detection originally compared start-time deltas only.

### 6. Validation as a second, independent pass

Before returning, `reflow()` re-validates its own output via `constraint-checker.ts` — channel-overlap, dependency-ordering, and blackout-window checks run *independently* of however the schedule was built, and a failure here throws rather than shipping a silently broken schedule. This is deliberately redundant: the placement algorithm should never produce an invalid schedule, but a second, independently-written check catches an algorithm bug instead of trusting the same logic twice.

## Performance at scale

A later review asked the deliberately harder question the core requirements don't: does this hold up at 1M tasks/day? The first pass didn't — two real O(n²)-class bugs, found by reasoning through the code rather than by a test failing:

- **`topologicalSort`'s ready queue re-sorted the entire array on every pop.** Correct for 5 tasks, but O(n² log n) overall — at n = 1,000,000 that never finishes in practice. Fixed with a proper binary min-heap (`src/reflow/min-heap.ts`); each task's `startDate` is also parsed to millis once up front instead of on every heap comparison. **Verified: 20,000 tasks sort in well under a second** (regression test in `dependency-graph.test.ts`).
- **The channel-busy interval list re-sorted itself on every insert and linear-scanned for conflicts.** O(k² log k) per busy channel. Fixed by extracting it into `ChannelAvailability` (`src/reflow/channel-availability.ts`) with binary-search insertion and a single-pass *merge* that collapses an entire contiguous run of touching bookings into one answer — the first version (binary search alone, still jumping past one booking at a time) took **24 seconds** for 1,500 tasks contending for the same instant on one channel; merging brought that to **~0.03 seconds**. The placement search's iteration cap (`MAX_PLACEMENT_ITERATIONS`, previously a flat 1,000) now scales with the channel's actual booking count, so a genuinely busy channel no longer falsely throws "no available slot."

**Honestly, this still isn't a full asymptotic fix.** An ad hoc stress test (every task wanting the exact same instant on one channel — the worst possible pattern) shows the shape returning at higher volume:

| tasks | time |
|---|---|
| 1,000 | 60ms |
| 5,000 | 286ms |
| 20,000 | 3.2s |
| 50,000 | 33s |

A single maximally-congested channel is still O(k²) in the worst case — a full fix needs an augmented interval tree (a balanced tree with max-endpoint aggregation) giving true O(log k) inserts *and* gap-queries, which wasn't built: real implementation effort and bug risk for a worst case this specific ("every task wants the literal same instant, zero natural spacing") is far harsher than realistic settlement load, where 1M tasks/day spread across a trading day and multiple channels would see nowhere near this level of single-point contention.

**Parallelism was considered and deliberately not pursued.** For `topologicalSort`, the heap-pop-one-at-a-time order is what implements the exact "earliest original start wins, globally, at every step" tie-break — a task can become ready mid-processing and immediately jump the queue. A layer-by-layer parallel version can't reproduce that without changing which task wins some ties, and the algorithm is already fast enough (O(n log n)) that there's no problem left to solve. For channel placement, two tasks on *different* channels with no dependency between them genuinely could be placed concurrently — but that doesn't help the worst case above at all (a single channel's bookings are inherently sequential, since each placement changes what's free for the next one on that same channel), and building it for real means worker threads, serializing Luxon `DateTime`s across the thread boundary (they aren't structured-cloneable), and a connected-components pass over the dependency graph to find genuinely independent task clusters — real infrastructure, worthwhile only if load is spread across many channels with substantial independent work each.

Also out of scope, flagged rather than silently assumed away: **incremental reflow**. `reflow()` recomputes the *entire* task universe on every call — a single disruption re-touches all 1M tasks, not just the ones actually downstream of it. At real production scale this is the change that would matter most, reshaping the API from `reflow(input)` toward something scoped to an affected subgraph — a bigger design conversation than a bug fix.

## Project structure

```
src/
├── index.ts                        # entry point: runs every scenario, writes CSVs
├── scenario-runner.ts               # loads a scenario JSON, runs reflow, builds the CSV
├── data/scenarios/                  # sample data, 5 scenarios (see below)
├── reflow/
│   ├── types.ts                     # core data model + ReflowInput/ReflowResult
│   ├── dependency-graph.ts          # DAG: dependency parsing + topological sort
│   ├── min-heap.ts                  # binary min-heap backing the topological sort's ready queue
│   ├── channel-availability.ts      # per-channel busy-interval tracking + placement search
│   ├── reflow.service.ts            # main algorithm: orchestration, holds, dependency floors, reasons
│   ├── constraint-checker.ts        # independent post-hoc schedule validation
│   ├── test-fixtures.ts             # shared builders used by the test suite
│   └── *.test.ts                    # unit + integration tests (39 tests)
└── utils/
    ├── date-utils.ts                 # operating-hours pause/resume calculator
    ├── date-utils.test.ts            # 16 tests
    └── csv.ts                        # minimal RFC 4180 CSV serializer
```

## Sample scenarios

All under `src/data/scenarios/`, each demonstrating a specific combination of constraints:

| # | Scenario | Demonstrates |
|---|----------|---------------|
| 01 | **Delay Cascade** | A late fund transfer pushes a dependent disbursement, which in turn bumps an unrelated task off the same channel — the spec's required "delay cascade" scenario. |
| 02 | **Market Hours Boundary** | A task's duration doesn't fit before the channel closes — mirrors the spec's own worked pause/resume example exactly, plus a dependent task waiting on the resumed completion. |
| 03 | **Channel Conflict Resolution** | Three mutually-independent tasks (no dependency relationship) all originally overlap on one channel; resolved purely by the earliest-original-start tie-break, cascading each one past the last. |
| 04 | **Complex Multi-Constraint** | Dependencies + a delayed upstream task + an immovable regulatory hold sitting exactly where the downstream task would otherwise land — the hold and the dependency wait combine in one task's explanation. |
| 05 | **Blackout Window** | A task lands squarely in a maintenance blackout and routes around it entirely, cascading to its dependent. |

Run `npm run dev` and open the generated `output/*.csv` files to see original vs. new schedule and the reason for every change.

## Testing

`npm test` runs 55 tests across 4 files (Jest, with `babel-jest` handling TypeScript transform — `ts-jest` doesn't yet support this project's TypeScript 7):

- **`date-utils.test.ts`** (16) — the spec's worked example, window boundaries (half-open, exact-close), weekend/multi-day gaps, malformed-window and negative/zero-duration edge cases.
- **`dependency-graph.test.ts`** (9) — linear and diamond dependency ordering, the tie-break rule, an empty task list, self-dependency and 2-node cycles, duplicate task `docId`s, and a 20,000-task scale regression guarding the heap fix.
- **`constraint-checker.test.ts`** (7) — each validation rule in isolation, including that overlapping times on *different* channels are correctly not flagged.
- **`reflow.service.test.ts`** (23) — end-to-end coverage of every constraint (dependencies, channel conflicts, regulatory holds, operating hours, blackout windows) and every error path (circular/dangling dependencies, unknown/duplicate channel ids, overlapping holds/blackouts, a hold whose dependency can't finish in time, a hold depending on another hold), plus general behavior (empty input, an already-valid schedule, output ordering) and a 1,500-task heavy-contention scale regression.

Two real bugs were found and fixed while writing the initial suite (both in `date-utils.ts`): a zero-duration task threw an internal "failed to converge" error instead of completing instantly, and a malformed operating-hours window (`startHour >= endHour`, or an hour outside 0–23) surfaced as a confusing error deep inside placement instead of a clear config error at the boundary (`assertValidOperatingHours`, called from every entry point). A third was caught while fixing the scale issues above: the merged-conflict search initially labeled a conflict with the *first* booking in a contiguous run rather than the *last* one — the interval whose end actually determines the new placement time — silently changing which task got blamed in a change's `reason` text. Caught by diffing all 5 scenarios' CSV output before and after the refactor.

## Trade-offs considered

- **Kahn's algorithm over a DFS-based topological sort for scheduling order.** A DFS-based sort was considered, but Kahn's BFS-layering has a property a DFS order doesn't guarantee for free: a task only becomes orderable once *all* its dependencies are already placed, so ties among tasks that become eligible at the same moment are broken purely by *their own* original start time. A DFS order can pull an unrelated task's position earlier just because one of *its* dependents happens to have an early start — which would silently violate the "earliest original start wins" contention rule. Cycle detection currently rides on `topologicalSort`'s own leftover-node fallback (it throws by naming the stuck tasks, just with a less precise message than a DFS cycle path would give).
- **Blackout windows reuse the channel-busy interval list; operating hours don't.** Discussed at length mid-build: blackout windows are concrete, finite `[startDate, endDate)` ranges — structurally identical to "another task is booked here" — so they slot into the exact same mechanism holds and conflicts already use. Operating hours are a recurring rule with no end date; forcing them into the same finite-interval shape would require materializing the rule out to some arbitrary horizon (and re-expanding if a task's dependency chain pushes past it). Keeping operating hours as a lazy, horizon-free pattern check and only unifying the genuinely finite constraints was the simpler and more robust choice.
- **CSV output over hardcoded console assertions for the sample scenarios.** The deliverable only requires demonstrating the algorithm works; a CSV with original/new/reason columns per task is easy to eyeball, diff, and open in a spreadsheet, and keeps the demo data (`src/data/scenarios/*.json`) fully decoupled from how results are inspected.

## Known limitations / next steps

- **`prepTimeMinutes`** (bonus) isn't implemented — settlement tasks are treated as pure processing time with no setup phase.
- **Optimization metrics** (total delay, utilization, SLA breach detection against `TradeOrder.settlementDate`) aren't implemented. `tradeOrders` is accepted by `ReflowInput` and threaded through every scenario, but nothing currently reads it.
- Regulatory holds are intentionally **not** validated against operating hours (a compliance-driven hold can reasonably occur outside normal market hours) — only checked against overlapping other holds/blackouts and against their own dependencies completing in time.
- **A single maximally-congested channel is still O(k²)** in the worst case (see [Performance at scale](#performance-at-scale)) — fixing that fully needs an augmented interval tree, not built here.
- **Reflow is all-or-nothing**: every call recomputes the entire task universe, and one malformed channel aborts the whole run rather than failing just that channel. Incremental, subgraph-scoped reflow would matter more than any of the algorithmic fixes above at real production scale, but reshapes the public API — a bigger design conversation than a bug fix.
