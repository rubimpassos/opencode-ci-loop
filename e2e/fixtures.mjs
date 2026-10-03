// Scenario presets for e2e/fake-gh.mjs. The state file is the single source of truth fake-gh reads on
// every invocation; the harness advances a scenario by rewriting it with `writeState` (atomic rename),
// so a concurrent gh call sees either the old or the new state, never a torn file.
//
// Wire shapes mirror the fixtures in src/gh.test.ts and src/gh-review.test.ts (what `gh` really prints).

import { renameSync, writeFileSync } from "node:fs"

export const FIXTURE_SLUG = "e2e/fixture"
export const FIXTURE_HOST = "github.com"
export const FIXTURE_REPO_URL = `https://${FIXTURE_HOST}/${FIXTURE_SLUG}`
export const FIXTURE_BRANCH = "feature/e2e"
export const AGENT_MARKER = "_🤖 via agent_"
/** Identifiable last line of the failed-job log; the injected report must carry it. */
export const FAILED_LOG_TAIL = "E2E-FAILURE-TAIL: expected 200, received 500"
export const EXTERNAL_STATUS_CONTEXT = "e2e/external-check"

const RUN_ID = { ci: 7001, lint: 7002 }

/** @typedef {"queued" | "in_progress" | "failure" | "green"} CiStage */

/** @param {{ sha: string, branch: string, stage: CiStage, runIdBase?: number }} input */
export function ciRuns({ sha, branch, stage, runIdBase = 0 }) {
  const run = (id, workflowName, status, conclusion) => ({
    databaseId: id + runIdBase,
    displayTitle: `e2e ${sha.slice(0, 7)}`,
    workflowName,
    status,
    conclusion,
    url: `${FIXTURE_REPO_URL}/actions/runs/${id + runIdBase}`,
    headBranch: branch,
  })
  switch (stage) {
    case "queued":
      return [run(RUN_ID.ci, "CI", "queued", ""), run(RUN_ID.lint, "Lint", "queued", "")]
    case "in_progress":
      return [run(RUN_ID.ci, "CI", "in_progress", ""), run(RUN_ID.lint, "Lint", "completed", "success")]
    case "failure":
      return [run(RUN_ID.ci, "CI", "completed", "failure"), run(RUN_ID.lint, "Lint", "completed", "success")]
    case "green":
      return [run(RUN_ID.ci, "CI", "completed", "success"), run(RUN_ID.lint, "Lint", "completed", "success")]
    default:
      throw new Error(`unknown CI stage: ${String(stage)}`)
  }
}

export function failedLog(runId) {
  return [
    `CI\tbuild\t2026-10-03T10:00:00Z ##[group]Run bun test`,
    `CI\tbuild\t2026-10-03T10:00:05Z (fail) e2e fixture > run ${runId}`,
    `CI\tbuild\t2026-10-03T10:00:05Z ${FAILED_LOG_TAIL}`,
  ].join("\n")
}

/** @param {{ number: number, branch: string, blocked: boolean }} input */
export function prView({ number, branch, blocked }) {
  const ciCheck = {
    __typename: "CheckRun",
    name: "build",
    status: "COMPLETED",
    conclusion: blocked ? "FAILURE" : "SUCCESS",
    detailsUrl: `${FIXTURE_REPO_URL}/actions/runs/${RUN_ID.ci}`,
    workflowName: "CI",
  }
  const external = {
    __typename: "StatusContext",
    context: EXTERNAL_STATUS_CONTEXT,
    state: blocked ? "FAILURE" : "SUCCESS",
    targetUrl: "https://status.e2e.invalid/fixture",
  }
  return {
    number,
    title: `feat: e2e fixture (${branch})`,
    url: `${FIXTURE_REPO_URL}/pull/${number}`,
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: blocked ? "BLOCKED" : "CLEAN",
    reviewDecision: blocked ? "CHANGES_REQUESTED" : "APPROVED",
    statusCheckRollup: [ciCheck, external],
  }
}

const comment = (id, login, body, path) => ({
  databaseId: id,
  state: "SUBMITTED",
  author: { login },
  body,
  path,
  line: path === null ? null : 12,
  url: `${FIXTURE_REPO_URL}/pull/1#discussion_r${id}`,
  createdAt: "2026-10-03T10:00:00Z",
  updatedAt: "2026-10-03T10:00:00Z",
})

/**
 * Review deltas for the GraphQL snapshot: 0 = no feedback, 1 = one unresolved Copilot thread,
 * 2 = the agent replied (marker line) and the thread is resolved, plus a new conversation comment.
 * @param {{ delta: 0 | 1 | 2, blocked: boolean }} input
 */
export function reviewPullRequest({ delta, blocked }) {
  const opener = comment(9001, "Copilot", "E2E-REVIEW: handle the empty response.", "src/app.ts")
  const reply = comment(9002, "e2e-user", `Fixed.\n${AGENT_MARKER}`, "src/app.ts")
  const threads =
    delta === 0
      ? []
      : [
          {
            id: "RT_e2e",
            isResolved: delta === 2,
            isOutdated: false,
            comments: { nodes: delta === 2 ? [opener, reply] : [opener] },
          },
        ]
  const reviews =
    delta === 0
      ? []
      : [
          {
            databaseId: 9101,
            author: { login: "copilot-pull-request-reviewer" },
            state: "COMMENTED",
            body: "E2E review summary",
            submittedAt: "2026-10-03T10:00:00Z",
            url: `${FIXTURE_REPO_URL}/pull/1#pullrequestreview-9101`,
          },
        ]
  const comments = delta === 2 ? [comment(9201, "octocat", "E2E-CONVERSATION: thanks!", null)] : []
  return {
    state: "OPEN",
    merged: false,
    reviewDecision: blocked ? "CHANGES_REQUESTED" : null,
    mergeStateStatus: blocked ? "BLOCKED" : "CLEAN",
    reviewThreads: { nodes: threads },
    reviews: { nodes: reviews },
    comments: { nodes: comments },
  }
}

/**
 * One repo's complete state. `commits` lets a second commit carry a different (green/failed) variant.
 * @param {{
 *   branch?: string, prNumber?: number, blocked?: boolean, reviewDelta?: 0 | 1 | 2, withPr?: boolean,
 *   commits: ReadonlyArray<{ sha: string, stage: CiStage }>,
 * }} input
 */
export function repoState({
  branch = FIXTURE_BRANCH,
  prNumber = 1,
  blocked = false,
  reviewDelta = 0,
  withPr = true,
  commits,
}) {
  const runsByCommit = {}
  const logs = {}
  commits.forEach(({ sha, stage }, index) => {
    const runs = ciRuns({ sha, branch, stage, runIdBase: index * 100 })
    runsByCommit[sha] = runs
    for (const run of runs)
      if (run.conclusion === "failure") logs[String(run.databaseId)] = failedLog(run.databaseId)
  })
  const lastSha = commits.at(-1)?.sha ?? ""
  return {
    commits: runsByCommit,
    logs,
    prs: withPr ? { [branch]: prView({ number: prNumber, branch, blocked }) } : {},
    pullCommits: { [String(prNumber)]: commits.length },
    ruleSuites: blocked ? [{ id: 501, after_sha: lastSha }] : [],
    ruleSuiteDetails: blocked
      ? {
          501: {
            rule_evaluations: [
              {
                rule_type: "required_status_checks",
                result: "fail",
                details: `${EXTERNAL_STATUS_CONTEXT} failing`,
              },
              { rule_type: "pull_request", result: "pass", details: null },
            ],
          },
        }
      : {},
    reviews: { [String(prNumber)]: reviewPullRequest({ delta: reviewDelta, blocked }) },
  }
}

/**
 * Full state file. `overrides` force a kind of call (run-list, run-view, pr-view, pulls-commits,
 * rule-suites, rule-suite, graphql) to exit with a scripted result and/or delay — refused/malformed
 * and slow-response scenarios.
 * @param {{ repos?: Record<string, unknown>, overrides?: Record<string, { exitCode?: number, stdout?: string, stderr?: string, delayMs?: number }> }} input
 */
export function ghState({ repos = {}, overrides = {} }) {
  return { version: 1, repos, overrides }
}

/** Atomic replace: write a sibling temp file, then rename over the target. */
export function writeState(path, state) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(tmp, path)
}
