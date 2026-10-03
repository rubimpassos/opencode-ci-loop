#!/usr/bin/env node
// Fake `gh` for the e2e stack. Put its directory (as an executable named `gh`) at the front of the
// OpenCode child PATH. It answers EXACTLY the argv shapes src/gh.ts issues and nothing else:
// unknown argv exits 1 and it never delegates to a real gh or touches the network.
//
// Env contract:
//   FAKE_GH_STATE  (required) JSON state file, see e2e/fixtures.mjs `ghState`/`repoState`. Re-read on
//                  every call; the harness advances the scenario by atomically replacing it.
//   FAKE_GH_LOG    (optional) every invocation is appended as one JSON line {at, argv, kind, exitCode}.

import { appendFileSync, readFileSync } from "node:fs"

const RUN_LIST_FIELDS = "databaseId,displayTitle,workflowName,status,conclusion,url,headBranch"
const PR_FIELDS = "number,title,url,state,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup"

const argv = process.argv.slice(2)

/** @param {string} url */
function slugOf(url) {
  const match = url.match(/^https:\/\/[^/]+\/([^/]+\/[^/]+?)(?:\.git)?$/)
  return match?.[1] ?? null
}

/** Matches argv against a pattern of literals and `{name}` captures; null when the shape differs. */
function match(pattern) {
  if (pattern.length !== argv.length) return null
  const captures = {}
  for (const [index, part] of pattern.entries()) {
    const value = argv[index] ?? ""
    const capture = part.match(/^\{(\w+)\}$/)
    if (capture?.[1] !== undefined) captures[capture[1]] = value
    else if (part !== value) return null
  }
  return captures
}

/** Resolves argv to `{ kind, slug, ...params }` or null for anything A does not issue. */
function classify() {
  const runList = match([
    "run",
    "list",
    "-R",
    "{repo}",
    "--commit",
    "{sha}",
    "--json",
    RUN_LIST_FIELDS,
    "--limit",
    "100",
  ])
  if (runList) return { kind: "run-list", slug: slugOf(runList.repo), sha: runList.sha }
  const runView = match(["run", "view", "-R", "{repo}", "{runId}", "--log-failed"])
  if (runView) return { kind: "run-view", slug: slugOf(runView.repo), runId: runView.runId }
  const prView = match(["pr", "view", "{branch}", "-R", "{repo}", "--json", PR_FIELDS])
  if (prView) return { kind: "pr-view", slug: slugOf(prView.repo), branch: prView.branch }
  const graphql = match([
    "api",
    "graphql",
    "--hostname",
    "{host}",
    "-f",
    "{query}",
    "-f",
    "{owner}",
    "-f",
    "{name}",
    "-F",
    "{number}",
  ])
  if (graphql) {
    const owner = graphql.owner.match(/^owner=(.+)$/)?.[1]
    const name = graphql.name.match(/^name=(.+)$/)?.[1]
    const number = graphql.number.match(/^number=(\d+)$/)?.[1]
    const isReviewQuery =
      graphql.query.startsWith("query=query(") && graphql.query.includes("pullRequest(number:$number)")
    if (!isReviewQuery || owner === undefined || name === undefined || number === undefined) return null
    return { kind: "graphql", slug: `${owner}/${name}`, number }
  }
  const pulls = match(["api", "--hostname", "{host}", "{path}", "--jq", ".commits"])
  const pullsPath = pulls?.path.match(/^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/)
  if (pullsPath?.[1] !== undefined) return { kind: "pulls-commits", slug: pullsPath[1], number: pullsPath[2] }
  const api = match(["api", "--hostname", "{host}", "{path}"])
  const suites = api?.path.match(
    /^repos\/([^/]+\/[^/]+)\/rulesets\/rule-suites\?ref=([^&]+)&rule_suite_result=fail&per_page=10$/,
  )
  if (suites?.[1] !== undefined) return { kind: "rule-suites", slug: suites[1] }
  const suite = api?.path.match(/^repos\/([^/]+\/[^/]+)\/rulesets\/rule-suites\/(\d+)$/)
  if (suite?.[1] !== undefined) return { kind: "rule-suite", slug: suite[1], suiteId: suite[2] }
  return null
}

const ok = (stdout) => ({ exitCode: 0, stdout, stderr: "" })
const fail = (stderr, exitCode = 1) => ({ exitCode, stdout: "", stderr })
const json = (value) => ok(`${JSON.stringify(value)}\n`)
const notFound = (what) => fail(`gh: Not Found (HTTP 404): ${what}\n`)

function respond(call, repo) {
  switch (call.kind) {
    case "run-list":
      return json(repo.commits?.[call.sha] ?? [])
    case "run-view": {
      const log = repo.logs?.[call.runId]
      return log === undefined ? fail(`run ${call.runId} has no failed jobs\n`) : ok(`${log}\n`)
    }
    case "pr-view": {
      const pr = repo.prs?.[call.branch]
      return pr === undefined ? fail(`no pull requests found for branch "${call.branch}"\n`) : json(pr)
    }
    case "pulls-commits": {
      const count = repo.pullCommits?.[call.number]
      return count === undefined ? notFound(`pulls/${call.number}`) : ok(`${count}\n`)
    }
    case "rule-suites":
      return json(repo.ruleSuites ?? [])
    case "rule-suite": {
      const detail = repo.ruleSuiteDetails?.[call.suiteId]
      return detail === undefined ? notFound(`rule-suites/${call.suiteId}`) : json(detail)
    }
    case "graphql": {
      const pullRequest = repo.reviews?.[call.number]
      return pullRequest === undefined
        ? fail(`GraphQL: Could not resolve to a PullRequest with the number of ${call.number}.\n`)
        : json({ data: { repository: { pullRequest } } })
    }
    default:
      return fail(`fake-gh: unhandled kind ${call.kind}\n`)
  }
}

function resolve(call) {
  const statePath = process.env.FAKE_GH_STATE
  if (!statePath) return { result: fail("fake-gh: FAKE_GH_STATE is not set\n", 2), delayMs: 0 }
  const state = JSON.parse(readFileSync(statePath, "utf8"))
  const override = state.overrides?.[call.kind]
  const delayMs = override?.delayMs ?? 0
  if (override && (override.exitCode !== undefined || override.stdout !== undefined)) {
    return {
      result: {
        exitCode: override.exitCode ?? 0,
        stdout: override.stdout ?? "",
        stderr: override.stderr ?? "",
      },
      delayMs,
    }
  }
  const repo = call.slug === null ? undefined : state.repos?.[call.slug]
  if (repo === undefined) return { result: fail(`fake-gh: no fixture for repo ${call.slug}\n`), delayMs }
  return { result: respond(call, repo), delayMs }
}

function main() {
  const call = classify()
  const { result, delayMs } = call
    ? resolve(call)
    : { result: fail(`fake-gh: unscripted argv: ${JSON.stringify(argv)}\n`), delayMs: 0 }
  if (process.env.FAKE_GH_LOG) {
    const entry = { at: Date.now(), argv, kind: call?.kind ?? null, exitCode: result.exitCode }
    appendFileSync(process.env.FAKE_GH_LOG, `${JSON.stringify(entry)}\n`)
  }
  setTimeout(() => {
    process.stdout.write(result.stdout)
    process.stderr.write(result.stderr)
    process.exitCode = result.exitCode
  }, delayMs)
}

main()
