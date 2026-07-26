import { describe, expect, it } from "bun:test"
import { parseReviewSnapshot, REVIEW_SNAPSHOT_QUERY } from "./gh-review.ts"
import { unresolvedThreadCount } from "./render-review.ts"

function responseWith(pullRequest: Record<string, unknown>): string {
  return JSON.stringify({ data: { repository: { pullRequest } } })
}

const BASE_PR = {
  state: "OPEN",
  merged: false,
  reviewDecision: null,
  mergeStateStatus: "CLEAN",
  reviewThreads: { nodes: [] },
  reviews: { nodes: [] },
  comments: { nodes: [] },
}

const FULL_RESPONSE = responseWith({
  state: "OPEN",
  merged: false,
  reviewDecision: "CHANGES_REQUESTED",
  mergeStateStatus: "UNSTABLE",
  reviewThreads: {
    nodes: [
      {
        id: "RT_copilot",
        isResolved: false,
        isOutdated: false,
        comments: {
          nodes: [
            {
              databaseId: 2001,
              author: { login: "Copilot" },
              body: "Consider handling the null case here.",
              path: "src/gh.ts",
              line: 42,
              url: "https://github.com/o/r/pull/12#discussion_r2001",
              createdAt: "2026-07-20T10:00:00Z",
              updatedAt: "2026-07-20T10:05:00Z",
            },
          ],
        },
      },
      {
        id: "RT_human",
        isResolved: true,
        isOutdated: true,
        comments: {
          nodes: [
            {
              databaseId: 2002,
              author: { login: "octocat" },
              body: "nit: rename this",
              path: "src/render.ts",
              line: 7,
              url: "https://github.com/o/r/pull/12#discussion_r2002",
              createdAt: "2026-07-20T11:00:00Z",
              updatedAt: "2026-07-20T11:00:00Z",
            },
            {
              databaseId: 2003,
              author: { login: "rubimpassos" },
              body: "done",
              path: "src/render.ts",
              line: 7,
              url: "https://github.com/o/r/pull/12#discussion_r2003",
              createdAt: "2026-07-20T11:30:00Z",
              updatedAt: "2026-07-20T11:30:00Z",
            },
          ],
        },
      },
    ],
  },
  reviews: {
    nodes: [
      {
        databaseId: 3001,
        author: { login: "copilot-pull-request-reviewer" },
        state: "COMMENTED",
        body: "Found 2 issues in this pull request.",
        submittedAt: "2026-07-20T10:00:00Z",
        url: "https://github.com/o/r/pull/12#pullrequestreview-3001",
      },
      {
        databaseId: 3002,
        author: { login: "octocat" },
        state: "CHANGES_REQUESTED",
        body: "",
        submittedAt: "2026-07-20T11:00:00Z",
        url: "https://github.com/o/r/pull/12#pullrequestreview-3002",
      },
    ],
  },
  comments: {
    nodes: [
      {
        databaseId: 4001,
        author: { login: "octocat" },
        body: "General PR conversation comment",
        url: "https://github.com/o/r/pull/12#issuecomment-4001",
        createdAt: "2026-07-20T12:00:00Z",
        updatedAt: "2026-07-20T12:00:00Z",
      },
    ],
  },
})

const THREAD_COMMENTS_PROJECTION = REVIEW_SNAPSHOT_QUERY.slice(
  REVIEW_SNAPSHOT_QUERY.indexOf("comments(first:50)"),
  REVIEW_SNAPSHOT_QUERY.indexOf("reviews(last:30)"),
)

/** The top-level `comments(last:50)` projection (`IssueComment`, which has no `state` field). */
const TOP_LEVEL_COMMENTS_PROJECTION = REVIEW_SNAPSHOT_QUERY.slice(
  REVIEW_SNAPSHOT_QUERY.indexOf("comments(last:50)"),
)

function threadCommentNode(databaseId: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    databaseId,
    author: { login: "rubimpassos" },
    body: `body ${databaseId}`,
    path: "src/gh.ts",
    line: databaseId,
    url: `https://github.com/o/r/pull/12#discussion_r${databaseId}`,
    createdAt: "2026-07-20T10:00:00Z",
    updatedAt: "2026-07-20T10:00:00Z",
    ...extra,
  }
}

function threadNode(id: string, commentNodes: readonly Record<string, unknown>[]): Record<string, unknown> {
  return { id, isResolved: false, isOutdated: false, comments: { nodes: commentNodes } }
}

describe("REVIEW_SNAPSHOT_QUERY", () => {
  it("requests the three review collections with locked page sizes", () => {
    expect(REVIEW_SNAPSHOT_QUERY).toContain("reviewThreads(first:100)")
    expect(REVIEW_SNAPSHOT_QUERY).toContain("reviews(last:30)")
    expect(REVIEW_SNAPSHOT_QUERY).toContain("comments(last:50)")
    expect(REVIEW_SNAPSHOT_QUERY).toContain("mergeStateStatus")
  })

  it("requests `state` on thread comments so pending drafts can be told apart", () => {
    expect(THREAD_COMMENTS_PROJECTION).toContain("state")
  })

  it("never requests `state` on top-level comments (IssueComment has no such field)", () => {
    expect(TOP_LEVEL_COMMENTS_PROJECTION).not.toContain("state")
  })
})

/**
 * `gh api graphql` authenticates AS THE USER, so an unsubmitted review the user is still drafting
 * on their own PR is fully visible to this token while invisible to everyone else. Without these
 * filters the agent would start "fixing" feedback that was never submitted (and may yet be deleted).
 */
describe("parseReviewSnapshot — unsubmitted (PENDING) review data", () => {
  it("drops a pending review and keeps submitted ones", () => {
    const json = responseWith({
      ...BASE_PR,
      reviews: {
        nodes: [
          {
            databaseId: 3001,
            author: { login: "rubimpassos" },
            state: "PENDING",
            body: "draft: still thinking about this one",
            submittedAt: "",
            url: "https://github.com/o/r/pull/12#pullrequestreview-3001",
          },
          {
            databaseId: 3002,
            author: { login: "octocat" },
            state: "CHANGES_REQUESTED",
            body: "submitted: please fix",
            submittedAt: "2026-07-20T11:00:00Z",
            url: "https://github.com/o/r/pull/12#pullrequestreview-3002",
          },
        ],
      },
    })

    const snapshot = parseReviewSnapshot(json, 12, 0)

    expect(snapshot.reviews.map((review) => review.databaseId)).toEqual([3002])
    expect(snapshot.reviews.map((review) => review.body)).toEqual(["submitted: please fix"])
  })

  it("drops a pending comment while its submitted siblings survive in the same thread", () => {
    const json = responseWith({
      ...BASE_PR,
      reviewThreads: {
        nodes: [
          threadNode("RT_mixed", [
            threadCommentNode(2001, { state: "SUBMITTED" }),
            threadCommentNode(2002, { state: "PENDING", body: "draft reply nobody has sent" }),
            threadCommentNode(2003, { state: "SUBMITTED" }),
          ]),
        ],
      },
    })

    const snapshot = parseReviewSnapshot(json, 12, 0)

    expect(snapshot.threads[0]?.comments.map((comment) => comment.databaseId)).toEqual([2001, 2003])
  })

  it("keeps a thread that mixes submitted and pending comments", () => {
    const json = responseWith({
      ...BASE_PR,
      reviewThreads: {
        nodes: [
          threadNode("RT_mixed", [
            threadCommentNode(2001, { state: "SUBMITTED" }),
            threadCommentNode(2002, { state: "PENDING" }),
          ]),
        ],
      },
    })

    const snapshot = parseReviewSnapshot(json, 12, 0)

    expect(snapshot.threads.map((thread) => thread.id)).toEqual(["RT_mixed"])
  })

  it("drops a thread whose only comment is pending (a brand-new draft thread)", () => {
    const json = responseWith({
      ...BASE_PR,
      reviewThreads: {
        nodes: [
          threadNode("RT_draft_only", [threadCommentNode(2001, { state: "PENDING" })]),
          threadNode("RT_submitted", [threadCommentNode(2002, { state: "SUBMITTED" })]),
        ],
      },
    })

    const snapshot = parseReviewSnapshot(json, 12, 0)

    expect(snapshot.threads.map((thread) => thread.id)).toEqual(["RT_submitted"])
  })

  it("keeps top-level PR comments, whose nodes carry no `state` field at all", () => {
    const json = responseWith({
      ...BASE_PR,
      comments: {
        nodes: [
          {
            databaseId: 4001,
            author: { login: "octocat" },
            body: "General PR conversation comment",
            url: "https://github.com/o/r/pull/12#issuecomment-4001",
            createdAt: "2026-07-20T12:00:00Z",
            updatedAt: "2026-07-20T12:00:00Z",
          },
        ],
      },
    })

    const snapshot = parseReviewSnapshot(json, 12, 0)

    expect(snapshot.comments.map((comment) => comment.databaseId)).toEqual([4001])
  })

  it("keeps a comment whose state is unknown garbage instead of throwing or dropping it", () => {
    const json = responseWith({
      ...BASE_PR,
      reviewThreads: {
        nodes: [threadNode("RT_garbage", [threadCommentNode(2001, { state: "SOMETHING_NEW" })])],
      },
    })

    const snapshot = parseReviewSnapshot(json, 12, 0)

    expect(snapshot.threads[0]?.comments.map((comment) => comment.databaseId)).toEqual([2001])
  })

  it("keeps a pending-only thread out of unresolvedThreadCount, so no phantom blocker is produced", () => {
    const pendingOnly = parseReviewSnapshot(
      responseWith({
        ...BASE_PR,
        reviewThreads: { nodes: [threadNode("RT_draft", [threadCommentNode(2001, { state: "PENDING" })])] },
      }),
      12,
      0,
    )
    const submitted = parseReviewSnapshot(
      responseWith({
        ...BASE_PR,
        reviewThreads: { nodes: [threadNode("RT_draft", [threadCommentNode(2001, { state: "SUBMITTED" })])] },
      }),
      12,
      0,
    )

    expect(unresolvedThreadCount(pendingOnly)).toBe(0)
    expect(unresolvedThreadCount(submitted)).toBe(1)
  })
})

describe("parseReviewSnapshot", () => {
  it("parses a full response with Copilot review, Copilot inline comments and a human thread", () => {
    const snapshot = parseReviewSnapshot(FULL_RESPONSE, 12, 1_753_000_000_000)

    expect(snapshot.prNumber).toBe(12)
    expect(snapshot.fetchedAt).toBe(1_753_000_000_000)
    expect(snapshot.prState).toBe("OPEN")
    expect(snapshot.merged).toBe(false)
    expect(snapshot.reviewDecision).toBe("CHANGES_REQUESTED")
    expect(snapshot.mergeStateStatus).toBe("UNSTABLE")

    expect(snapshot.threads).toHaveLength(2)
    expect(snapshot.threads[0]?.id).toBe("RT_copilot")
    expect(snapshot.threads[0]?.isResolved).toBe(false)
    expect(snapshot.threads[0]?.comments[0]).toEqual({
      databaseId: 2001,
      author: "Copilot",
      body: "Consider handling the null case here.",
      path: "src/gh.ts",
      line: 42,
      url: "https://github.com/o/r/pull/12#discussion_r2001",
      createdAt: "2026-07-20T10:00:00Z",
      updatedAt: "2026-07-20T10:05:00Z",
    })
    expect(snapshot.threads[1]?.isResolved).toBe(true)
    expect(snapshot.threads[1]?.isOutdated).toBe(true)
    expect(snapshot.threads[1]?.comments.map((comment) => comment.author)).toEqual(["octocat", "rubimpassos"])

    expect(snapshot.reviews).toHaveLength(2)
    expect(snapshot.reviews[0]?.author).toBe("copilot-pull-request-reviewer")
    expect(snapshot.reviews[0]?.state).toBe("COMMENTED")
    expect(snapshot.reviews[1]?.state).toBe("CHANGES_REQUESTED")

    expect(snapshot.comments).toHaveLength(1)
    expect(snapshot.comments[0]?.path).toBeNull()
    expect(snapshot.comments[0]?.line).toBeNull()
  })

  it("falls back to author 'unknown' when author is null (deleted account)", () => {
    const json = responseWith({
      ...BASE_PR,
      reviewThreads: {
        nodes: [
          {
            id: "RT_1",
            isResolved: false,
            isOutdated: false,
            comments: {
              nodes: [
                {
                  databaseId: 1,
                  author: null,
                  body: "ghost comment",
                  path: null,
                  line: null,
                  url: "https://x",
                  createdAt: "2026-01-01T00:00:00Z",
                  updatedAt: "2026-01-01T00:00:00Z",
                },
              ],
            },
          },
        ],
      },
      reviews: {
        nodes: [
          {
            databaseId: 2,
            author: null,
            state: "APPROVED",
            body: "",
            submittedAt: "2026-01-01T00:00:00Z",
            url: "https://x",
          },
        ],
      },
    })

    const snapshot = parseReviewSnapshot(json, 1, 0)

    expect(snapshot.threads[0]?.comments[0]?.author).toBe("unknown")
    expect(snapshot.reviews[0]?.author).toBe("unknown")
  })

  it("is resilient to malformed fields: bad enums fall back, missing arrays become empty", () => {
    const json = responseWith({
      state: "SOMETHING_NEW",
      merged: "not-a-boolean",
      reviewDecision: "BOGUS",
      mergeStateStatus: "WHO_KNOWS",
      reviews: { nodes: [{ databaseId: 5, author: { login: "x" }, state: "BOGUS_STATE" }] },
    })

    const snapshot = parseReviewSnapshot(json, 7, 0)

    expect(snapshot.prState).toBe("OPEN")
    expect(snapshot.merged).toBe(false)
    expect(snapshot.reviewDecision).toBeNull()
    expect(snapshot.mergeStateStatus).toBe("UNKNOWN")
    expect(snapshot.threads).toEqual([])
    expect(snapshot.comments).toEqual([])
    expect(snapshot.reviews[0]?.state).toBe("COMMENTED")
    expect(snapshot.reviews[0]?.body).toBe("")
  })

  it("filters out garbage nodes and nodes without a numeric databaseId", () => {
    const json = responseWith({
      ...BASE_PR,
      reviewThreads: {
        nodes: [
          "garbage-string",
          {
            id: "RT_ok",
            isResolved: false,
            isOutdated: false,
            comments: {
              nodes: [
                "not-an-object",
                { author: { login: "no-id" }, body: "missing databaseId" },
                {
                  databaseId: 9,
                  author: { login: "kept" },
                  body: "valid",
                  path: null,
                  line: null,
                  url: "https://x",
                  createdAt: "2026-01-01T00:00:00Z",
                  updatedAt: "2026-01-01T00:00:00Z",
                },
              ],
            },
          },
        ],
      },
      reviews: { nodes: [{ author: { login: "no-id-review" }, state: "APPROVED" }] },
      comments: { nodes: [42] },
    })

    const snapshot = parseReviewSnapshot(json, 3, 0)

    expect(snapshot.threads).toHaveLength(1)
    expect(snapshot.threads[0]?.comments).toHaveLength(1)
    expect(snapshot.threads[0]?.comments[0]?.author).toBe("kept")
    expect(snapshot.reviews).toEqual([])
    expect(snapshot.comments).toEqual([])
  })

  it("reports a merged PR", () => {
    const snapshot = parseReviewSnapshot(responseWith({ ...BASE_PR, state: "MERGED", merged: true }), 99, 0)

    expect(snapshot.merged).toBe(true)
    expect(snapshot.prState).toBe("MERGED")
  })

  it("reports a closed PR", () => {
    const snapshot = parseReviewSnapshot(responseWith({ ...BASE_PR, state: "CLOSED" }), 99, 0)

    expect(snapshot.prState).toBe("CLOSED")
    expect(snapshot.merged).toBe(false)
  })
})
