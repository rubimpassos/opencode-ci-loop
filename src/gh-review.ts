import { z } from "zod"
import {
  PR_MERGE_STATE_STATUSES,
  PR_REVIEW_DECISIONS,
  PR_STATES,
  REVIEW_STATES,
  type ReviewComment,
  type ReviewInfo,
  type ReviewSnapshot,
  type ReviewThread,
} from "./types.ts"

export const REVIEW_SNAPSHOT_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      state merged reviewDecision mergeStateStatus
      reviewThreads(first:100){nodes{id isResolved isOutdated
        comments(first:50){nodes{databaseId state author{login} body path line url createdAt updatedAt}}}}
      reviews(last:30){nodes{databaseId author{login} state body submittedAt url}}
      comments(last:50){nodes{databaseId author{login} body url createdAt updatedAt}}
    }
  }
}`

const AuthorSchema = z
  .object({ login: z.string().catch("unknown") })
  .nullable()
  .catch(null)

const NodesSchema = z
  .object({ nodes: z.array(z.unknown()).catch([]) })
  .catch({ nodes: [] })
  .transform((connection) => connection.nodes)

/**
 * `PullRequestReviewCommentState`, absent on top-level `IssueComment`s — which are never pending.
 *
 * `gh api graphql` authenticates AS THE USER, so a review the user is still drafting on their own PR
 * is visible to this token while invisible to everyone else. Every PENDING comment and review is
 * dropped here, at the parse boundary, so `ReviewSnapshot` never carries unsubmitted data and the
 * agent never "fixes" feedback that was never sent (and may yet be deleted). Threads the filter
 * empties are dropped too: a draft-only thread would otherwise inflate `unresolvedThreadCount` into
 * a blocker nobody else can see.
 */
const COMMENT_STATES = ["PENDING", "SUBMITTED"] as const

const CommentNodeSchema = z.object({
  databaseId: z.number().nullable().catch(null),
  state: z.enum(COMMENT_STATES).nullable().catch(null),
  author: AuthorSchema,
  body: z.string().catch(""),
  path: z.string().nullable().catch(null),
  line: z.number().nullable().catch(null),
  url: z.string().catch(""),
  createdAt: z.string().catch(""),
  updatedAt: z.string().catch(""),
})

const ThreadNodeSchema = z.object({
  id: z.string().catch(""),
  isResolved: z.boolean().catch(false),
  isOutdated: z.boolean().catch(false),
  comments: NodesSchema,
})

const ReviewNodeSchema = z.object({
  databaseId: z.number().nullable().catch(null),
  author: AuthorSchema,
  state: z.enum(REVIEW_STATES).catch("COMMENTED"),
  body: z.string().catch(""),
  submittedAt: z.string().catch(""),
  url: z.string().catch(""),
})

const ReviewResponseSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        state: z.enum(PR_STATES).catch("OPEN"),
        merged: z.boolean().catch(false),
        reviewDecision: z.enum(PR_REVIEW_DECISIONS).nullable().catch(null),
        mergeStateStatus: z.enum(PR_MERGE_STATE_STATUSES).catch("UNKNOWN"),
        reviewThreads: NodesSchema,
        reviews: NodesSchema,
        comments: NodesSchema,
      }),
    }),
  }),
})

function parseComment(node: unknown): ReviewComment | null {
  const parsed = CommentNodeSchema.safeParse(node)
  if (!parsed.success || parsed.data.databaseId === null || parsed.data.state === "PENDING") return null
  return {
    databaseId: parsed.data.databaseId,
    author: parsed.data.author?.login ?? "unknown",
    body: parsed.data.body,
    path: parsed.data.path,
    line: parsed.data.line,
    url: parsed.data.url,
    createdAt: parsed.data.createdAt,
    updatedAt: parsed.data.updatedAt,
  }
}

function parseThread(node: unknown): ReviewThread | null {
  const parsed = ThreadNodeSchema.safeParse(node)
  if (!parsed.success) return null
  const comments = parseAll(parsed.data.comments, parseComment)
  if (comments.length === 0) return null
  return {
    id: parsed.data.id,
    isResolved: parsed.data.isResolved,
    isOutdated: parsed.data.isOutdated,
    comments,
  }
}

function parseReview(node: unknown): ReviewInfo | null {
  const parsed = ReviewNodeSchema.safeParse(node)
  if (!parsed.success || parsed.data.databaseId === null || parsed.data.state === "PENDING") return null
  return {
    databaseId: parsed.data.databaseId,
    author: parsed.data.author?.login ?? "unknown",
    state: parsed.data.state,
    body: parsed.data.body,
    submittedAt: parsed.data.submittedAt,
    url: parsed.data.url,
  }
}

function parseAll<T>(nodes: readonly unknown[], parse: (node: unknown) => T | null): readonly T[] {
  return nodes.map(parse).filter((node): node is T => node !== null)
}

export function parseReviewSnapshot(json: string, prNumber: number, fetchedAt: number): ReviewSnapshot {
  const { pullRequest } = ReviewResponseSchema.parse(JSON.parse(json)).data.repository
  return {
    prNumber,
    prState: pullRequest.state,
    merged: pullRequest.merged,
    reviewDecision: pullRequest.reviewDecision,
    mergeStateStatus: pullRequest.mergeStateStatus,
    threads: parseAll(pullRequest.reviewThreads, parseThread),
    reviews: parseAll(pullRequest.reviews, parseReview),
    comments: parseAll(pullRequest.comments, parseComment),
    fetchedAt,
  }
}
