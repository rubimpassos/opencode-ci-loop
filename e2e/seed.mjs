import assert from "node:assert/strict"
import { z } from "zod"
import {
  EXTERNAL_STATUS_CONTEXT,
  FAILED_LOG_TAIL,
  FIXTURE_SLUG,
  ghState,
  repoState,
  writeState,
} from "./fixtures.mjs"
import { progress, until } from "./lifecycle.mjs"

const Run = z
  .object({ status: z.enum(["queued", "in_progress", "completed"]), conclusion: z.string().nullable() })
  .passthrough()
const Report = z
  .object({
    runs: z.array(Run),
    failedLogs: z.array(z.object({ logTail: z.string() }).passthrough()),
    pr: z
      .object({
        mergeStateStatus: z.string(),
        checks: z.array(z.object({ name: z.string(), status: z.string() }).passthrough()),
      })
      .passthrough()
      .nullable(),
  })
  .passthrough()
const Phase = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("waiting") }),
  z.object({ kind: z.literal("running"), runs: z.array(Run) }),
  z.object({ kind: z.literal("done"), report: Report }),
  z.object({ kind: z.literal("reviewing"), report: Report }).passthrough(),
  z.object({ kind: z.literal("review-ended"), report: Report }).passthrough(),
  z.object({ kind: z.literal("timed-out"), runs: z.array(Run) }),
  z.object({ kind: z.literal("error"), message: z.string() }),
])
const Session = z
  .object({
    sessionID: z.string(),
    watches: z.array(z.object({ sha: z.string(), phase: Phase }).passthrough()),
  })
  .passthrough()

function runsOf(phase) {
  switch (phase.kind) {
    case "waiting":
      return []
    case "running":
      return phase.runs
    case "done":
    case "reviewing":
    case "review-ended":
      return phase.report.runs
    case "error":
      assert.fail(`Plugin watch failed: ${phase.message}`)
      break
    case "timed-out":
      assert.fail("Plugin watch timed out")
      break
    default:
      assert.fail(`Unexpected phase: ${phase.kind}`)
  }
}

async function waitForReport(stack, id) {
  return until(
    `plugin report and assistant reply in ${id}`,
    async () => {
      const messages = await stack.messages(id)
      const index = messages.findIndex(
        (message) => message.role === "user" && message.text.startsWith("[ci-loop] "),
      )
      return (
        index >= 0 &&
        messages
          .slice(index + 1)
          .some((message) => message.role === "assistant" && message.complete && message.text.length > 0)
      )
    },
    stack.signal,
  )
}

export async function seed(stack, artifacts) {
  progress("Seeding failure session using the real shell tool")
  const failedSha = stack.fixture.commit("feat: failing e2e change")
  const setStage = (stage) =>
    writeState(
      stack.env.FAKE_GH_STATE,
      ghState({
        repos: {
          [FIXTURE_SLUG]: repoState({ blocked: true, commits: [{ sha: failedSha, stage }] }),
        },
      }),
    )
  setStage("queued")
  const failed = await stack.createSession("E2E failed CI + blocked PR")
  await stack.prompt(failed, "E2E-PUSH")
  artifacts.json("seed/push-messages.json", await stack.messages(failed))
  const state = async (id) => Session.parse(await stack.ci(`/sessions/${id}`))
  for (const stage of ["queued", "in_progress"]) {
    setStage(stage)
    const observed = await until(
      `real plugin observes ${stage}`,
      async () => {
        const current = await state(failed)
        return current.watches.some(
          (watch) => watch.sha === failedSha && runsOf(watch.phase).some((run) => run.status === stage),
        )
          ? current
          : null
      },
      stack.signal,
    )
    artifacts.json(`seed/${stage}.json`, observed)
  }
  setStage("failure")
  const failure = await until(
    "failed report with actual log tail, check and blocked PR",
    async () => {
      const current = await state(failed)
      const found = current.watches.some((watch) => {
        switch (watch.phase.kind) {
          case "done":
          case "reviewing":
          case "review-ended": {
            const report = watch.phase.report
            return (
              report.failedLogs.some((log) => log.logTail.includes(FAILED_LOG_TAIL)) &&
              report.pr?.mergeStateStatus === "BLOCKED" &&
              report.pr.checks.some(
                (check) => check.name === EXTERNAL_STATUS_CONTEXT && check.status === "failing",
              )
            )
          }
          case "waiting":
          case "running":
            return false
          case "error":
          case "timed-out":
            runsOf(watch.phase)
            return false
          default:
            return assert.fail(`Unexpected phase: ${watch.phase.kind}`)
        }
      })
      return found ? current : null
    },
    stack.signal,
  )
  artifacts.json("seed/failure.json", failure)
  await waitForReport(stack, failed)
  await stack.prompt(failed, "E2E-WATCH-status")

  progress("Seeding a second session with green CI")
  const greenSha = stack.fixture.commit("feat: passing e2e change")
  writeState(
    stack.env.FAKE_GH_STATE,
    ghState({
      repos: {
        [FIXTURE_SLUG]: repoState({
          commits: [
            { sha: failedSha, stage: "failure" },
            { sha: greenSha, stage: "green" },
          ],
        }),
      },
    }),
  )
  const green = await stack.createSession("E2E green CI")
  await stack.prompt(green, "E2E-PUSH")
  const success = await until(
    "second session has completed green runs",
    async () => {
      const current = await state(green)
      return current.watches.some((watch) => {
        const runs = runsOf(watch.phase)
        return (
          watch.sha === greenSha &&
          runs.length > 0 &&
          runs.every((run) => run.status === "completed" && run.conclusion === "success")
        )
      })
        ? current
        : null
    },
    stack.signal,
  )
  await waitForReport(stack, green)
  artifacts.json("seed/green.json", success)
  const result = { failed, green, failedSha, greenSha, directory: stack.fixture.repo }
  artifacts.json("seed/sessions.json", result)
  return result
}
