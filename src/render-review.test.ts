import { describe, expect, it } from "bun:test"
import { CATALOGS } from "./i18n.ts"
import {
  renderMarkerInstruction,
  renderMidCiReviewUpdate,
  renderPostCiReviewUpdate,
  renderReviewEnded,
  renderReviewSection,
  unresolvedThreadCount,
} from "./render-review.ts"
import type {
  MidCiReviewUpdate,
  NewCommentEvent,
  ReviewComment,
  ReviewDelta,
  ReviewInfo,
  ReviewSnapshot,
  ReviewThread,
  WorkflowRun,
} from "./types.ts"

const MARKER = "_🤖 via agent_"
const CTX = { repo: "github.com/o/r", prNumber: 42 }

function makeComment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    databaseId: 1,
    author: "Copilot",
    body: "Use a constant here",
    path: "src/app.ts",
    line: 10,
    url: "https://github.com/o/r/pull/42#discussion_r1",
    createdAt: "2026-07-24T10:00:00Z",
    updatedAt: "2026-07-24T10:00:00Z",
    ...overrides,
  }
}

function makeEvent(comment: ReviewComment, overrides: Partial<NewCommentEvent> = {}): NewCommentEvent {
  return {
    comment,
    threadId: "T1",
    isResolved: false,
    path: comment.path,
    line: comment.line,
    ...overrides,
  }
}

function makeReview(overrides: Partial<ReviewInfo> = {}): ReviewInfo {
  return {
    databaseId: 900,
    author: "copilot-pull-request-reviewer",
    state: "CHANGES_REQUESTED",
    body: "",
    submittedAt: "2026-07-24T10:00:00Z",
    url: "https://github.com/o/r/pull/42#pullrequestreview-900",
    ...overrides,
  }
}

function makeThread(id: string, isResolved: boolean, comments: readonly ReviewComment[]): ReviewThread {
  return { id, isResolved, isOutdated: false, comments }
}

function makeSnapshot(overrides: Partial<ReviewSnapshot> = {}): ReviewSnapshot {
  return {
    prNumber: 42,
    prState: "OPEN",
    merged: false,
    reviewDecision: null,
    mergeStateStatus: "CLEAN",
    threads: [],
    reviews: [],
    comments: [],
    fetchedAt: 0,
    ...overrides,
  }
}

function emptyDelta(overrides: Partial<ReviewDelta> = {}): ReviewDelta {
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

function makeRun(id: number, status: WorkflowRun["status"]): WorkflowRun {
  return {
    id,
    name: "ci",
    workflowName: "CI",
    status,
    conclusion: status === "completed" ? "success" : null,
    url: `https://github.com/o/r/actions/runs/${id}`,
    branch: "main",
  }
}

describe("renderMarkerInstruction", () => {
  it("returns a 3-line block starting with --- and containing the marker", () => {
    const lines = renderMarkerInstruction(MARKER)
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe("---")
    expect(lines.join("\n")).toContain(MARKER)
  })

  it("defaults to en and localizes for pt-BR", () => {
    const en = renderMarkerInstruction(MARKER, "en")
    expect(renderMarkerInstruction(MARKER)).toEqual(en)
    const pt = renderMarkerInstruction(MARKER, "pt-BR")
    expect(pt).toHaveLength(3)
    expect(pt.join("\n")).toContain(MARKER)
    expect(pt).not.toEqual(en)
  })
})

function midCiFixture(): MidCiReviewUpdate {
  const copilotInline = makeComment({ databaseId: 1 })
  const copilotFileLevel = makeComment({
    databaseId: 2,
    body: "Missing test coverage",
    path: "src/lib.ts",
    line: null,
    url: "https://github.com/o/r/pull/42#discussion_r2",
  })
  const aliceTopLevel = makeComment({
    databaseId: 3,
    author: "alice",
    body: "first line\nsecond line",
    path: null,
    line: null,
    url: "https://github.com/o/r/pull/42#issuecomment-3",
  })
  const bobInline = makeComment({
    databaseId: 4,
    author: "bob",
    body: "nit: rename",
    path: "src/x.ts",
    line: 3,
    url: "https://github.com/o/r/pull/42#discussion_r4",
  })
  return {
    delta: emptyDelta({
      newComments: [
        makeEvent(copilotInline),
        makeEvent(copilotFileLevel, { threadId: "T2", line: null }),
        makeEvent(aliceTopLevel, { threadId: null, isResolved: null, path: null, line: null }),
        makeEvent(bobInline, { threadId: "T3" }),
      ],
      newReviews: [makeReview()],
      unresolved: { from: 0, to: 3 },
    }),
    snapshot: makeSnapshot(),
    runs: [makeRun(1, "completed"), makeRun(2, "completed"), makeRun(3, "in_progress")],
  }
}

describe("renderMidCiReviewUpdate (template A)", () => {
  it("renders header with PR number and completed/total run counts", () => {
    const out = renderMidCiReviewUpdate(midCiFixture(), CTX, MARKER)
    expect(out).toContain("[ci-loop]")
    expect(out).toContain("PR #42")
    expect(out).toContain("2/3")
  })

  it("merges Copilot login variants into one bot group with review state and inline count", () => {
    const out = renderMidCiReviewUpdate(midCiFixture(), CTX, MARKER)
    expect(out.split("**Copilot**")).toHaveLength(2)
    expect(out).toContain("🤖 **Copilot**")
    expect(out).toContain("CHANGES_REQUESTED, 2")
  })

  it("orders bot groups before humans and humans alphabetically", () => {
    const out = renderMidCiReviewUpdate(midCiFixture(), CTX, MARKER)
    const copilot = out.indexOf("🤖 **Copilot**")
    const alice = out.indexOf("👤 **alice**")
    const bob = out.indexOf("👤 **bob**")
    expect(copilot).toBeGreaterThanOrEqual(0)
    expect(copilot).toBeLessThan(alice)
    expect(alice).toBeLessThan(bob)
  })

  it("omits the review state segment for authors without a new review", () => {
    const out = renderMidCiReviewUpdate(midCiFixture(), CTX, MARKER)
    const bobLine = out.split("\n").find((line) => line.includes("**bob**"))
    expect(bobLine).toBe("👤 **bob**")
  })

  it("numbers unresolved items with backticked path:line and the URL", () => {
    const out = renderMidCiReviewUpdate(midCiFixture(), CTX, MARKER)
    expect(out).toContain("1. ❌")
    expect(out).toContain("`src/app.ts:10`")
    expect(out).toContain("(https://github.com/o/r/pull/42#discussion_r1)")
  })

  it("renders file-level comments with path only and conversation comments with the catalog label", () => {
    const out = renderMidCiReviewUpdate(midCiFixture(), CTX, MARKER)
    expect(out).toContain("`src/lib.ts`")
    expect(out).not.toContain("src/lib.ts:")
    expect(out).toContain(CATALOGS.en.prConversationContext)
  })

  it("quotes every line of multi-line bodies", () => {
    const out = renderMidCiReviewUpdate(midCiFixture(), CTX, MARKER)
    expect(out).toContain("> first line\n> second line")
  })

  it("includes the mid-CI instruction and puts the marker block last", () => {
    const out = renderMidCiReviewUpdate(midCiFixture(), CTX, MARKER)
    expect(out).toContain(CATALOGS.en.reviewMidCiInstruction)
    expect(out).toContain(MARKER)
    expect(out.split("\n").slice(-3)).toEqual([...renderMarkerInstruction(MARKER)])
  })

  it("localizes header and instruction for pt-BR while keeping bodies, logins and enums verbatim", () => {
    const en = renderMidCiReviewUpdate(midCiFixture(), CTX, MARKER, "en")
    const pt = renderMidCiReviewUpdate(midCiFixture(), CTX, MARKER, "pt-BR")
    expect(pt.split("\n")[0]).not.toBe(en.split("\n")[0])
    expect(pt).toContain("PR #42")
    expect(pt).toContain("2/3")
    expect(pt).toContain(CATALOGS["pt-BR"].reviewMidCiInstruction)
    expect(pt).toContain("> first line")
    expect(pt).toContain("**alice**")
    expect(pt).toContain("CHANGES_REQUESTED")
    expect(pt).toContain("https://github.com/o/r/pull/42#discussion_r1")
    expect(pt.split("\n").slice(-3)).toEqual([...renderMarkerInstruction(MARKER, "pt-BR")])
  })
})

function postCiFixture(): { delta: ReviewDelta; snapshot: ReviewSnapshot } {
  const aliceRoot = makeComment({
    databaseId: 10,
    author: "alice",
    body: "please rename",
    path: "src/app.ts",
    line: 5,
    url: "https://github.com/o/r/pull/42#discussion_r10",
  })
  const eveRoot = makeComment({
    databaseId: 20,
    author: "eve",
    body: "root",
    path: "src/lib.ts",
    line: 7,
    url: "https://github.com/o/r/pull/42#discussion_r20",
  })
  const bobReply = makeComment({
    databaseId: 21,
    author: "bob",
    body: "agreed",
    path: "src/lib.ts",
    line: 7,
    url: "https://github.com/o/r/pull/42#discussion_r21",
  })
  const carolTopLevel = makeComment({
    databaseId: 30,
    author: "carol",
    body: "overall question",
    path: null,
    line: null,
    url: "https://github.com/o/r/pull/42#issuecomment-30",
  })
  const snapshot = makeSnapshot({
    threads: [makeThread("T1", false, [aliceRoot]), makeThread("T2", false, [eveRoot, bobReply])],
  })
  const delta = emptyDelta({
    newComments: [
      makeEvent(aliceRoot, { threadId: "T1" }),
      makeEvent(bobReply, { threadId: "T2" }),
      makeEvent(carolTopLevel, { threadId: null, isResolved: null, path: null, line: null }),
    ],
    newReviews: [makeReview({ databaseId: 901, author: "dan", state: "APPROVED", body: "LGTM overall" })],
    decisionChange: { from: null, to: "CHANGES_REQUESTED" },
    mergeStateChange: { from: "UNSTABLE", to: "BLOCKED" },
    unresolved: { from: 2, to: 4 },
  })
  return { delta, snapshot }
}

describe("renderPostCiReviewUpdate (template C)", () => {
  it("renders the no-CI-change header and a New comments section counting comments plus bodied reviews", () => {
    const { delta, snapshot } = postCiFixture()
    const out = renderPostCiReviewUpdate(delta, snapshot, null, CTX, MARKER)
    expect(out).toContain("PR #42")
    expect(out.split("\n")[0]).toBe(CATALOGS.en.reviewPostCiHeader(CTX.repo, CTX.prNumber))
    expect(out).toContain(CATALOGS.en.newCommentsSection(4))
  })

  it("labels entries with new-thread, new-reply and PR-conversation contexts", () => {
    const { delta, snapshot } = postCiFixture()
    const out = renderPostCiReviewUpdate(delta, snapshot, null, CTX, MARKER)
    expect(out).toContain(CATALOGS.en.newThreadContext("src/app.ts:5"))
    expect(out).toContain(CATALOGS.en.newReplyContext("src/lib.ts:7"))
    expect(out).toContain(CATALOGS.en.prConversationContext)
    expect(out).toContain("(https://github.com/o/r/pull/42#issuecomment-30)")
  })

  it("includes bodied new reviews as their own quoted entries", () => {
    const { delta, snapshot } = postCiFixture()
    const out = renderPostCiReviewUpdate(delta, snapshot, null, CTX, MARKER)
    expect(out).toContain("👤 **dan**")
    expect(out).toContain("APPROVED")
    expect(out).toContain("> LGTM overall")
  })

  it("lists only actual PR status changes with from → to lines", () => {
    const { delta, snapshot } = postCiFixture()
    const out = renderPostCiReviewUpdate(delta, snapshot, null, CTX, MARKER)
    expect(out).toContain(CATALOGS.en.prStatusChangeSection)
    expect(out).toContain("reviewDecision: — → CHANGES_REQUESTED")
    expect(out).toContain("unresolved conversations: 2 → 4")
    expect(out).toContain("mergeStateStatus: UNSTABLE → BLOCKED")
  })

  it("omits the status section when nothing changed and skips the unresolved line when counts are equal", () => {
    const { snapshot } = postCiFixture()
    const delta = emptyDelta({
      newComments: [makeEvent(makeComment({ databaseId: 50, author: "alice" }), { threadId: "T9" })],
      unresolved: { from: 3, to: 3 },
    })
    const out = renderPostCiReviewUpdate(delta, snapshot, null, CTX, MARKER)
    expect(out).not.toContain(CATALOGS.en.prStatusChangeSection)
    expect(out).not.toContain("unresolved conversations:")
  })

  it("renders the not-ready blocker list when readiness has blockers", () => {
    const { delta, snapshot } = postCiFixture()
    const readiness = { ready: false, blockers: ["CI checks failing", "4 unresolved review conversations"] }
    const out = renderPostCiReviewUpdate(delta, snapshot, readiness, CTX, MARKER)
    expect(out).toContain(CATALOGS.en.notReadyToMerge)
    expect(out).toContain("- CI checks failing")
    expect(out).toContain("- 4 unresolved review conversations")
    expect(out).not.toContain(CATALOGS.en.readyToMerge)
  })

  it("renders the ready line when readiness is ready and no readiness block when null", () => {
    const { delta, snapshot } = postCiFixture()
    const ready = renderPostCiReviewUpdate(delta, snapshot, { ready: true, blockers: [] }, CTX, MARKER)
    expect(ready).toContain(CATALOGS.en.readyToMerge)
    const none = renderPostCiReviewUpdate(delta, snapshot, null, CTX, MARKER)
    expect(none).not.toContain(CATALOGS.en.readyToMerge)
    expect(none).not.toContain(CATALOGS.en.notReadyToMerge)
  })

  it("includes the address instruction and puts the marker block last", () => {
    const { delta, snapshot } = postCiFixture()
    const out = renderPostCiReviewUpdate(delta, snapshot, null, CTX, MARKER)
    expect(out).toContain(CATALOGS.en.reviewAddressInstruction)
    expect(out.split("\n").slice(-3)).toEqual([...renderMarkerInstruction(MARKER)])
  })

  it("localizes headers and instructions for pt-BR keeping bodies and enums verbatim", () => {
    const { delta, snapshot } = postCiFixture()
    const en = renderPostCiReviewUpdate(delta, snapshot, null, CTX, MARKER, "en")
    const pt = renderPostCiReviewUpdate(delta, snapshot, null, CTX, MARKER, "pt-BR")
    expect(pt.split("\n")[0]).not.toBe(en.split("\n")[0])
    expect(pt).toContain(CATALOGS["pt-BR"].reviewAddressInstruction)
    expect(pt).toContain("> please rename")
    expect(pt).toContain("CHANGES_REQUESTED")
    expect(pt.split("\n").slice(-3)).toEqual([...renderMarkerInstruction(MARKER, "pt-BR")])
  })
})

describe("renderReviewEnded (template D)", () => {
  const delta = emptyDelta({
    decisionChange: { from: "CHANGES_REQUESTED", to: "APPROVED" },
    mergeStateChange: { from: "BLOCKED", to: "CLEAN" },
    unresolved: { from: 3, to: 0 },
  })

  it("renders header, resolved summary, changed status lines and the ready line", () => {
    const out = renderReviewEnded({ snapshot: makeSnapshot(), delta, reason: "ready" }, CTX)
    expect(out.split("\n")[0]).toBe(CATALOGS.en.reviewFinalHeader(CTX.repo, CTX.prNumber))
    expect(out).toContain("3 → 0")
    expect(out).toContain("reviewDecision: CHANGES_REQUESTED → APPROVED")
    expect(out).toContain("mergeStateStatus: BLOCKED → CLEAN")
    expect(out).toContain("✅ PR #42")
  })

  it("ends with the literal review-watch-ended line and has no marker block", () => {
    const out = renderReviewEnded({ snapshot: makeSnapshot(), delta, reason: "ready" }, CTX)
    const lines = out.split("\n")
    expect(lines.at(-1)).toBe("[review watch ended]")
    expect(lines).not.toContain("---")
  })

  it("omits status delta lines that are absent from the delta", () => {
    const bare = emptyDelta({ unresolved: { from: 1, to: 0 } })
    const out = renderReviewEnded({ snapshot: makeSnapshot(), delta: bare, reason: "ready" }, CTX)
    expect(out).not.toContain("reviewDecision:")
    expect(out).not.toContain("mergeStateStatus:")
    expect(out).toContain("1 → 0")
  })

  it("localizes for pt-BR keeping the ended literal last", () => {
    const pt = renderReviewEnded({ snapshot: makeSnapshot(), delta, reason: "ready" }, CTX, "pt-BR")
    const en = renderReviewEnded({ snapshot: makeSnapshot(), delta, reason: "ready" }, CTX, "en")
    expect(pt).not.toBe(en)
    expect(pt.split("\n").at(-1)).toBe("[review watch ended]")
    expect(pt).toContain("3 → 0")
  })
})

describe("renderReviewSection (template B section)", () => {
  function sectionSnapshot(): ReviewSnapshot {
    const copilotRoot = makeComment({ databaseId: 1 })
    const copilotReply = makeComment({ databaseId: 2, author: "alice", body: "done" })
    const resolvedRoot = makeComment({
      databaseId: 3,
      author: "alice",
      body: "resolved body",
      path: "src/old.ts",
      line: 1,
      url: "https://github.com/o/r/pull/42#discussion_r3",
    })
    const aliceRoot = makeComment({
      databaseId: 4,
      author: "alice",
      body: "extract this",
      path: "src/lib.ts",
      line: 20,
      url: "https://github.com/o/r/pull/42#discussion_r4",
    })
    return makeSnapshot({
      threads: [
        makeThread("T1", false, [copilotRoot, copilotReply]),
        makeThread("T2", true, [resolvedRoot]),
        makeThread("T3", false, [aliceRoot]),
      ],
      reviews: [
        makeReview({ body: "Please fix these issues" }),
        makeReview({ databaseId: 901, author: "alice", state: "COMMENTED", body: "" }),
      ],
    })
  }

  it("returns the unresolved count and a section header with that count", () => {
    const { lines, unresolvedCount } = renderReviewSection(sectionSnapshot())
    expect(unresolvedCount).toBe(2)
    expect(lines[0]).toBe(CATALOGS.en.reviewCommentsSection(2))
  })

  it("numbers unresolved thread root comments with location and quoted body, excluding resolved threads", () => {
    const joined = renderReviewSection(sectionSnapshot()).lines.join("\n")
    expect(joined).toContain("1. ❌")
    expect(joined).toContain("2. ❌")
    expect(joined).toContain("`src/app.ts:10`")
    expect(joined).toContain("`src/lib.ts:20`")
    expect(joined).toContain("> Use a constant here")
    expect(joined).not.toContain("resolved body")
    expect(joined).not.toContain("src/old.ts")
  })

  it("groups bots before humans and quotes bodied review intros", () => {
    const joined = renderReviewSection(sectionSnapshot()).lines.join("\n")
    expect(joined).toContain("🤖 **Copilot**")
    expect(joined).toContain("CHANGES_REQUESTED")
    expect(joined).toContain("> Please fix these issues")
    expect(joined.indexOf("**Copilot**")).toBeLessThan(joined.indexOf("**alice**"))
  })

  it("localizes the section header for pt-BR", () => {
    const { lines } = renderReviewSection(sectionSnapshot(), "pt-BR")
    expect(lines[0]).toBe(CATALOGS["pt-BR"].reviewCommentsSection(2))
  })
})

describe("unresolvedThreadCount", () => {
  function mixedSnapshot(): ReviewSnapshot {
    return makeSnapshot({
      threads: [
        makeThread("T1", false, [makeComment()]),
        makeThread("T2", true, [makeComment({ databaseId: 2 })]),
        makeThread("T3", false, [makeComment({ databaseId: 3, author: "alice" })]),
        makeThread("T4", true, [makeComment({ databaseId: 4 })]),
      ],
    })
  }

  it("counts only unresolved threads", () => {
    expect(unresolvedThreadCount(mixedSnapshot())).toBe(2)
  })

  it("counts zero when every thread is resolved", () => {
    const snapshot = makeSnapshot({ threads: [makeThread("T1", true, [makeComment()])] })
    expect(unresolvedThreadCount(snapshot)).toBe(0)
  })

  it("matches renderReviewSection().unresolvedCount for the same snapshot", () => {
    const snapshot = mixedSnapshot()

    const count = unresolvedThreadCount(snapshot)

    expect(count).toBe(2)
    expect(count).toBe(renderReviewSection(snapshot).unresolvedCount)
  })
})
