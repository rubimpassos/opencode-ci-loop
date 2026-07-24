import { describe, expect, it } from "bun:test"
import { computeDelta, evaluateReviewCycle, isBotAuthor, isEmptyDelta, unresolvedCount } from "./review.ts"
import type { ReviewComment, ReviewDelta, ReviewInfo, ReviewSnapshot, ReviewThread } from "./types.ts"
import { REVIEW_STATES } from "./types.ts"

function comment(databaseId: number, overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    databaseId,
    author: "alice",
    body: "please fix this",
    path: "src/app.ts",
    line: 10,
    url: `https://github.com/o/r/pull/7#discussion_r${databaseId}`,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
    ...overrides,
  }
}

function thread(
  id: string,
  comments: readonly ReviewComment[],
  overrides: Partial<ReviewThread> = {},
): ReviewThread {
  return { id, isResolved: false, isOutdated: false, comments, ...overrides }
}

function review(databaseId: number, overrides: Partial<ReviewInfo> = {}): ReviewInfo {
  return {
    databaseId,
    author: "bob",
    state: "COMMENTED",
    body: "review body",
    submittedAt: "2026-07-01T00:00:00Z",
    url: `https://github.com/o/r/pull/7#pullrequestreview-${databaseId}`,
    ...overrides,
  }
}

function snapshot(overrides: Partial<ReviewSnapshot> = {}): ReviewSnapshot {
  return {
    prNumber: 7,
    prState: "OPEN",
    merged: false,
    reviewDecision: null,
    mergeStateStatus: "UNSTABLE",
    threads: [],
    reviews: [],
    comments: [],
    fetchedAt: 1_000,
    ...overrides,
  }
}

function delta(overrides: Partial<ReviewDelta> = {}): ReviewDelta {
  return {
    newComments: [],
    newReviews: [],
    threadsResolved: [],
    threadsUnresolved: [],
    decisionChange: null,
    mergeStateChange: null,
    unresolved: { from: 0, to: 0 },
    ...overrides,
  }
}

const OPTIONS = { agentMarker: "_🤖 via agent_", ignoreAuthors: [] as readonly string[] }

describe("computeDelta", () => {
  it("returns an empty seed delta when prev is null, with unresolved from = to = current count", () => {
    const curr = snapshot({
      threads: [
        thread("t1", [comment(1)]),
        thread("t2", [comment(2)], { isResolved: true }),
        thread("t3", []),
      ],
      reviews: [review(100)],
      comments: [comment(50, { path: null, line: null })],
    })
    const result = computeDelta(null, curr, OPTIONS)
    expect(result).toEqual(delta({ unresolved: { from: 2, to: 2 } }))
    expect(isEmptyDelta(result)).toBe(true)
  })

  it("reports a comment in a brand-new thread with the thread's id and resolution flag", () => {
    const prev = snapshot()
    const curr = snapshot({ threads: [thread("t1", [comment(1, { path: "src/gh.ts", line: 42 })])] })
    const result = computeDelta(prev, curr, OPTIONS)
    expect(result.newComments).toEqual([
      {
        comment: comment(1, { path: "src/gh.ts", line: 42 }),
        threadId: "t1",
        isResolved: false,
        path: "src/gh.ts",
        line: 42,
      },
    ])
    expect(result.unresolved).toEqual({ from: 0, to: 1 })
  })

  it("reports only the new reply in an existing thread", () => {
    const prev = snapshot({ threads: [thread("t1", [comment(1)])] })
    const curr = snapshot({ threads: [thread("t1", [comment(1), comment(2, { author: "carol" })])] })
    const result = computeDelta(prev, curr, OPTIONS)
    expect(result.newComments).toHaveLength(1)
    expect(result.newComments[0]?.comment.databaseId).toBe(2)
    expect(result.newComments[0]?.threadId).toBe("t1")
  })

  it("reports a new top-level PR comment with null threadId and null isResolved", () => {
    const prev = snapshot({ comments: [comment(50, { path: null, line: null })] })
    const curr = snapshot({
      comments: [comment(50, { path: null, line: null }), comment(51, { path: null, line: null })],
    })
    const result = computeDelta(prev, curr, OPTIONS)
    expect(result.newComments).toEqual([
      {
        comment: comment(51, { path: null, line: null }),
        threadId: null,
        isResolved: null,
        path: null,
        line: null,
      },
    ])
  })

  for (const state of REVIEW_STATES) {
    it(`reports a new review in state ${state}`, () => {
      const prev = snapshot({ reviews: [review(100)] })
      const curr = snapshot({ reviews: [review(100), review(101, { state })] })
      const result = computeDelta(prev, curr, OPTIONS)
      expect(result.newReviews).toEqual([review(101, { state })])
    })
  }

  it("reports a false→true resolution flip in threadsResolved with path/line from the first comment", () => {
    const prev = snapshot({ threads: [thread("t1", [comment(1, { path: "a.ts", line: 3 })])] })
    const curr = snapshot({
      threads: [thread("t1", [comment(1, { path: "a.ts", line: 3 })], { isResolved: true })],
    })
    const result = computeDelta(prev, curr, OPTIONS)
    expect(result.threadsResolved).toEqual([{ threadId: "t1", path: "a.ts", line: 3 }])
    expect(result.threadsUnresolved).toEqual([])
    expect(result.unresolved).toEqual({ from: 1, to: 0 })
  })

  it("reports a true→false flip in threadsUnresolved with null path/line when the thread has no comments", () => {
    const prev = snapshot({ threads: [thread("t1", [], { isResolved: true })] })
    const curr = snapshot({ threads: [thread("t1", [])] })
    const result = computeDelta(prev, curr, OPTIONS)
    expect(result.threadsUnresolved).toEqual([{ threadId: "t1", path: null, line: null }])
    expect(result.threadsResolved).toEqual([])
    expect(result.unresolved).toEqual({ from: 0, to: 1 })
  })

  it("reports decisionChange when reviewDecision differs and null when unchanged", () => {
    const prev = snapshot({ reviewDecision: null })
    const changed = computeDelta(prev, snapshot({ reviewDecision: "CHANGES_REQUESTED" }), OPTIONS)
    expect(changed.decisionChange).toEqual({ from: null, to: "CHANGES_REQUESTED" })
    const unchanged = computeDelta(prev, snapshot({ reviewDecision: null }), OPTIONS)
    expect(unchanged.decisionChange).toBeNull()
  })

  it("reports mergeStateChange when mergeStateStatus differs and null when unchanged", () => {
    const prev = snapshot({ mergeStateStatus: "UNSTABLE" })
    const changed = computeDelta(prev, snapshot({ mergeStateStatus: "BLOCKED" }), OPTIONS)
    expect(changed.mergeStateChange).toEqual({ from: "UNSTABLE", to: "BLOCKED" })
    const unchanged = computeDelta(prev, snapshot({ mergeStateStatus: "UNSTABLE" }), OPTIONS)
    expect(unchanged.mergeStateChange).toBeNull()
  })

  it("excludes comments and reviews whose last non-empty line contains the agent marker", () => {
    const prev = snapshot()
    const curr = snapshot({
      threads: [thread("t1", [comment(1, { body: "done, fixed\n_🤖 via agent_" })])],
      comments: [comment(51, { body: "replied\n_🤖 via agent_", path: null, line: null })],
      reviews: [review(101, { body: "auto review\n_🤖 via agent_" })],
    })
    const result = computeDelta(prev, curr, OPTIONS)
    expect(result.newComments).toEqual([])
    expect(result.newReviews).toEqual([])
  })

  it("keeps comments whose marker only appears mid-body", () => {
    const prev = snapshot()
    const curr = snapshot({
      threads: [
        thread("t1", [comment(1, { body: "quoting _🤖 via agent_ here\nbut a human wrote the rest" })]),
      ],
    })
    const result = computeDelta(prev, curr, OPTIONS)
    expect(result.newComments).toHaveLength(1)
    expect(result.newComments[0]?.comment.databaseId).toBe(1)
  })

  it("tolerates trailing whitespace and newlines after the marker line", () => {
    const prev = snapshot()
    const curr = snapshot({ threads: [thread("t1", [comment(1, { body: "ok\n_🤖 via agent_\n\n " })])] })
    const result = computeDelta(prev, curr, OPTIONS)
    expect(result.newComments).toEqual([])
  })

  it("excludes authors listed in ignoreAuthors by exact login match only", () => {
    const prev = snapshot()
    const curr = snapshot({
      threads: [thread("t1", [comment(1, { author: "dependabot[bot]" }), comment(2, { author: "Alice" })])],
      reviews: [review(101, { author: "dependabot[bot]" }), review(102, { author: "carol" })],
    })
    const options = { agentMarker: OPTIONS.agentMarker, ignoreAuthors: ["dependabot[bot]", "alice"] }
    const result = computeDelta(prev, curr, options)
    expect(result.newComments.map((event) => event.comment.databaseId)).toEqual([2])
    expect(result.newReviews.map((info) => info.databaseId)).toEqual([102])
  })

  it("does not re-report an edited comment (same databaseId, new updatedAt)", () => {
    const prev = snapshot({ threads: [thread("t1", [comment(1)])] })
    const curr = snapshot({
      threads: [thread("t1", [comment(1, { body: "edited body", updatedAt: "2026-07-02T00:00:00Z" })])],
    })
    const result = computeDelta(prev, curr, OPTIONS)
    expect(result.newComments).toEqual([])
    expect(isEmptyDelta(result)).toBe(true)
  })
})

describe("isEmptyDelta", () => {
  const rows: readonly { readonly name: string; readonly input: ReviewDelta; readonly expected: boolean }[] =
    [
      { name: "all arrays empty, changes null, unresolved stable", input: delta(), expected: true },
      {
        name: "a new comment",
        input: delta({
          newComments: [{ comment: comment(1), threadId: "t1", isResolved: false, path: null, line: null }],
        }),
        expected: false,
      },
      { name: "a new review", input: delta({ newReviews: [review(100)] }), expected: false },
      {
        name: "a resolved thread",
        input: delta({ threadsResolved: [{ threadId: "t1", path: null, line: null }] }),
        expected: false,
      },
      {
        name: "an unresolved thread",
        input: delta({ threadsUnresolved: [{ threadId: "t1", path: null, line: null }] }),
        expected: false,
      },
      {
        name: "a decision change",
        input: delta({ decisionChange: { from: null, to: "APPROVED" } }),
        expected: false,
      },
      {
        name: "a merge-state change",
        input: delta({ mergeStateChange: { from: "UNSTABLE", to: "CLEAN" } }),
        expected: false,
      },
      {
        name: "an unresolved count change",
        input: delta({ unresolved: { from: 1, to: 2 } }),
        expected: false,
      },
    ]
  for (const row of rows) {
    it(`is ${row.expected} with ${row.name}`, () => {
      expect(isEmptyDelta(row.input)).toBe(row.expected)
    })
  }
})

describe("unresolvedCount", () => {
  it("returns 0 for null", () => {
    expect(unresolvedCount(null)).toBe(0)
  })

  it("counts only threads with isResolved false", () => {
    const snap = snapshot({
      threads: [thread("t1", []), thread("t2", [], { isResolved: true }), thread("t3", [])],
    })
    expect(unresolvedCount(snap)).toBe(2)
  })
})

describe("isBotAuthor", () => {
  const rows: readonly { readonly login: string; readonly expected: boolean }[] = [
    { login: "Copilot", expected: true },
    { login: "copilot-pull-request-reviewer", expected: true },
    { login: "dependabot[bot]", expected: true },
    { login: "github-actions[bot]", expected: true },
    { login: "copilot", expected: false },
    { login: "alice", expected: false },
    { login: "bot", expected: false },
  ]
  for (const row of rows) {
    it(`returns ${row.expected} for ${row.login}`, () => {
      expect(isBotAuthor(row.login)).toBe(row.expected)
    })
  }
})

describe("evaluateReviewCycle", () => {
  const notifyDelta = delta({
    newComments: [{ comment: comment(1), threadId: "t1", isResolved: false, path: null, line: null }],
    unresolved: { from: 1, to: 1 },
  })
  const readyDelta = delta({
    threadsResolved: [{ threadId: "t1", path: "a.ts", line: 3 }],
    unresolved: { from: 2, to: 0 },
  })

  it("ends with reason merged when the PR is merged, before any other rule", () => {
    const snap = snapshot({ merged: true, prState: "MERGED" })
    const outcome = evaluateReviewCycle({
      delta: notifyDelta,
      snapshot: snap,
      nowMs: 10_000,
      idleDeadline: 5_000,
    })
    expect(outcome).toEqual({ kind: "end", reason: "merged", delta: notifyDelta })
  })

  it("ends with reason closed when prState is not OPEN and the PR is not merged", () => {
    const snap = snapshot({ prState: "CLOSED" })
    const outcome = evaluateReviewCycle({ delta: delta(), snapshot: snap, nowMs: 0, idleDeadline: 5_000 })
    expect(outcome).toEqual({ kind: "end", reason: "closed", delta: delta() })
  })

  it("ends with reason idle-timeout when nowMs reaches the deadline, even with an empty delta", () => {
    const outcome = evaluateReviewCycle({
      delta: delta(),
      snapshot: snapshot(),
      nowMs: 5_000,
      idleDeadline: 5_000,
    })
    expect(outcome).toEqual({ kind: "end", reason: "idle-timeout", delta: delta() })
  })

  it("prefers idle-timeout over ready when the deadline has passed", () => {
    const snap = snapshot({ reviewDecision: "APPROVED", mergeStateStatus: "CLEAN" })
    const outcome = evaluateReviewCycle({
      delta: readyDelta,
      snapshot: snap,
      nowMs: 9_000,
      idleDeadline: 5_000,
    })
    expect(outcome).toEqual({ kind: "end", reason: "idle-timeout", delta: readyDelta })
  })

  it("ends with reason ready when threads drop to zero on an APPROVED, CLEAN PR", () => {
    const snap = snapshot({ reviewDecision: "APPROVED", mergeStateStatus: "CLEAN" })
    const outcome = evaluateReviewCycle({ delta: readyDelta, snapshot: snap, nowMs: 0, idleDeadline: 5_000 })
    expect(outcome).toEqual({ kind: "end", reason: "ready", delta: readyDelta })
  })

  it("ends with reason ready when reviewDecision is null and the PR is CLEAN", () => {
    const snap = snapshot({ reviewDecision: null, mergeStateStatus: "CLEAN" })
    const outcome = evaluateReviewCycle({ delta: readyDelta, snapshot: snap, nowMs: 0, idleDeadline: 5_000 })
    expect(outcome).toEqual({ kind: "end", reason: "ready", delta: readyDelta })
  })

  it("notifies (not ready) when threads drop to zero but mergeStateStatus is not CLEAN", () => {
    const snap = snapshot({ reviewDecision: "APPROVED", mergeStateStatus: "UNSTABLE" })
    const outcome = evaluateReviewCycle({ delta: readyDelta, snapshot: snap, nowMs: 0, idleDeadline: 5_000 })
    expect(outcome).toEqual({ kind: "notify", delta: readyDelta })
  })

  it("notifies (not ready) when threads drop to zero but reviewDecision is CHANGES_REQUESTED", () => {
    const snap = snapshot({ reviewDecision: "CHANGES_REQUESTED", mergeStateStatus: "CLEAN" })
    const outcome = evaluateReviewCycle({ delta: readyDelta, snapshot: snap, nowMs: 0, idleDeadline: 5_000 })
    expect(outcome).toEqual({ kind: "notify", delta: readyDelta })
  })

  it("notifies (not ready) when unresolved.from is already zero", () => {
    const snap = snapshot({ reviewDecision: "APPROVED", mergeStateStatus: "CLEAN" })
    const zeroFromDelta = delta({
      newComments: [{ comment: comment(1), threadId: null, isResolved: null, path: null, line: null }],
    })
    const outcome = evaluateReviewCycle({
      delta: zeroFromDelta,
      snapshot: snap,
      nowMs: 0,
      idleDeadline: 5_000,
    })
    expect(outcome).toEqual({ kind: "notify", delta: zeroFromDelta })
  })

  it("notifies with the same delta for a generic non-empty delta", () => {
    const outcome = evaluateReviewCycle({
      delta: notifyDelta,
      snapshot: snapshot(),
      nowMs: 0,
      idleDeadline: 5_000,
    })
    expect(outcome).toEqual({ kind: "notify", delta: notifyDelta })
  })

  it("continues on an empty delta before the idle deadline on an open PR", () => {
    const outcome = evaluateReviewCycle({
      delta: delta(),
      snapshot: snapshot(),
      nowMs: 4_999,
      idleDeadline: 5_000,
    })
    expect(outcome).toEqual({ kind: "continue" })
  })
})
