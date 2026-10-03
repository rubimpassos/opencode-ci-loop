#!/usr/bin/env node
// Prerequisites (B): bun run --cwd packages/sdk build && bun run build:web.
// Run: node e2e/run.mjs --scenario all [--serve] [--keep]
// Override OPENCHAMBER_CLI, OPENCODE_BINARY, E2E_ARTIFACTS for another local checkout.
// all means this part's S2/S4api/S6api only; browser acceptance is explicitly out of scope.
import assert from "node:assert/strict"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { Artifacts } from "./artifacts.mjs"
import { Processes, progress } from "./lifecycle.mjs"
import { S2, S4api, S6api } from "./scenarios.mjs"
import { seed } from "./seed.mjs"
import { startStack } from "./stack.mjs"

const { values } = parseArgs({
  options: {
    scenario: { type: "string", default: "all" },
    serve: { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
  },
})
const scenarios = { S2, S4api, S6api }
assert(
  values.scenario === "all" || Object.hasOwn(scenarios, values.scenario),
  "--scenario must be S2|S4api|S6api|all (browser scenarios belong to part B)",
)
const selected = values.scenario === "all" ? Object.keys(scenarios) : [values.scenario]
const root = fileURLToPath(new URL("../", import.meta.url))
const artifacts = new Artifacts(
  resolve(process.env.E2E_ARTIFACTS || join(root, ".omo/evidence/openchamber-extension")),
)
mkdirSync("/tmp/opencode", { recursive: true })
const scratch = mkdtempSync("/tmp/opencode/ci-e2e-")
const processes = new Processes()
const controller = new AbortController()
const stop = () => controller.abort()
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
const results = []
let stack
progress(`Scratch: ${scratch}`)
try {
  // E2E_PACKAGE_ROOT runs the stack against an unpacked `npm pack` tarball instead of this checkout.
  const packageRoot = process.env.E2E_PACKAGE_ROOT ? resolve(process.env.E2E_PACKAGE_ROOT) : root
  stack = await startStack({ root, packageRoot, scratch, artifacts, processes, signal: controller.signal })
  const seeded = await seed(stack, artifacts)
  for (const name of selected) {
    progress(`Scenario: ${name}`)
    const started = Date.now()
    try {
      const details = await scenarios[name](stack, seeded)
      const result = {
        scenario: name,
        ok: true,
        exitStatus: 0,
        command: `node e2e/run.mjs --scenario ${name}`,
        versions: stack.versions,
        durationMs: Date.now() - started,
        ...details,
      }
      artifacts.json(`${name}/results.json`, result)
      artifacts.logs(stack.dirs.logs, name)
      results.push({ scenario: name, ok: true })
      progress(`PASS ${name}`)
    } catch (error) {
      if (!(error instanceof Error)) throw error
      const result = {
        scenario: name,
        ok: false,
        exitStatus: 1,
        command: `node e2e/run.mjs --scenario ${name}`,
        versions: stack.versions,
        error: error.stack,
      }
      artifacts.json(`${name}/results.json`, result)
      artifacts.logs(stack.dirs.logs, name)
      results.push(result)
      progress(`FAIL ${name}: ${artifacts.redact(error.message)}`)
    }
  }
  if (values.serve && results.every((result) => result.ok)) {
    // Deliberately private manual-mode output. Never use --serve in the evidence tee command.
    console.log(
      `OC_URL=${stack.ocUrl}\nCI_URL=${stack.ciUrl}\nSID=${seeded.failed}\nGREEN_SID=${seeded.green}\nUI_PASSWORD=${stack.password}\nCOOKIE_JAR=${stack.cookieJar}\nGUEST_TOKEN=${await stack.guestToken()}\nDIRECTORY=${stack.fixture.repo}`,
    )
    progress("Serving seeded stack; SIGINT stops all children")
    if (!controller.signal.aborted)
      await new Promise((done) => controller.signal.addEventListener("abort", done, { once: true }))
  }
} catch (error) {
  if (!(error instanceof Error)) throw error
  results.push({ scenario: "setup", ok: false, exitStatus: 1, error: error.stack })
  progress(`FAIL setup: ${artifacts.redact(error.message)}`)
} finally {
  progress("Stopping owned process groups")
  try {
    await processes.close()
  } finally {
    try {
      const logs = join(scratch, "logs")
      if (existsSync(logs)) {
        for (const [source, name] of [
          ["data/opencode/log/opencode.log", "opencode-runtime.log"],
          ["state/cli/ci-loop-v2.log", "plugin.log"],
        ]) {
          const file = join(scratch, source)
          if (existsSync(file)) copyFileSync(file, join(logs, name))
        }
        artifacts.logs(logs)
        for (const name of selected) artifacts.logs(logs, name)
      }
      artifacts.json("T13a-results.json", results)
      for (const name of selected) {
        if (!results.some((result) => result.scenario === name))
          artifacts.json(`${name}/results.json`, {
            scenario: name,
            ok: false,
            exitStatus: 1,
            blockedBy: "setup",
            errors: results,
          })
      }
    } finally {
      if (values.keep) progress(`Kept private scratch: ${scratch}`)
      else rmSync(scratch, { recursive: true, force: true })
      process.removeListener("SIGINT", stop)
      process.removeListener("SIGTERM", stop)
    }
  }
}
process.exitCode = results.some((result) => !result.ok) ? 1 : 0
progress(`${results.filter((result) => result.ok).length}/${results.length} passed`)
