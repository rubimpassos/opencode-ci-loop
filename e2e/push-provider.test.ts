import { afterAll, describe, expect, it } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { bunExec } from "../src/gh.ts"
import { resolvePushTargets } from "../src/resolve.ts"
import { PUSH_COMMAND, startFakeProvider } from "./fake-provider.mjs"
import { FIXTURE_BRANCH, FIXTURE_REPO_URL } from "./fixtures.mjs"
import { createGitFixture, FIXTURE_ORIGIN } from "./git-fixture.mjs"

mkdirSync("/tmp/opencode", { recursive: true })
const scratch = mkdtempSync("/tmp/opencode/ci-loop-push-provider-")
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

describe("git fixture", () => {
  const shell = (fixture: ReturnType<typeof createGitFixture>, command: string) =>
    execFileSync("sh", ["-c", `${command} 2>&1`], {
      cwd: fixture.repo,
      env: { ...process.env, ...fixture.env },
      encoding: "utf8",
    })
  const bareHead = (fixture: ReturnType<typeof createGitFixture>) =>
    execFileSync("git", ["-C", fixture.bare, "rev-parse", FIXTURE_BRANCH], { encoding: "utf8" }).trim()

  it("lands the scripted push in the local bare repo with a GitHub-shaped To line", () => {
    const fixture = createGitFixture({ scratch })
    const sha = fixture.commit("feat: e2e change")

    const output = shell(fixture, PUSH_COMMAND)

    expect(output.split("\n")[0]).toBe(`To ${FIXTURE_ORIGIN}`)
    expect(shell(fixture, "git remote get-url origin").trim()).toBe(FIXTURE_ORIGIN)
    expect(bareHead(fixture)).toBe(sha)
  })

  it("feeds A's real push resolver a GitHub target from the human-format push output", async () => {
    const fixture = createGitFixture({ scratch })
    const sha = fixture.commit("feat: e2e change")
    const output = shell(fixture, PUSH_COMMAND)

    const targets = await resolvePushTargets(
      output,
      PUSH_COMMAND,
      {},
      { exec: bunExec, sessionDir: fixture.repo },
    )
    expect(targets).toEqual([
      expect.objectContaining({
        sha,
        branch: FIXTURE_BRANCH,
        repoUrl: FIXTURE_REPO_URL,
        sourceKind: "session",
      }),
    ])
  })

  it("refuses any non-fixture transport instead of reaching the network", () => {
    const fixture = createGitFixture({ scratch })

    const attempt = () =>
      execFileSync("git", ["ls-remote", "https://github.com/e2e/other.git"], {
        cwd: fixture.repo,
        env: { ...process.env, ...fixture.env },
        stdio: "pipe",
      })

    expect(attempt).toThrow(/transport 'https' not allowed/)
  })
})

type Chunk = {
  readonly choices: readonly {
    readonly delta: {
      readonly content?: string
      readonly tool_calls?: readonly {
        readonly index: number
        readonly id: string
        readonly type: string
        readonly function: { readonly name: string; readonly arguments: string }
      }[]
    }
    readonly finish_reason: string | null
  }[]
}

const tools = ["shell", "ci_watch"].map((name) => ({ type: "function", function: { name, parameters: {} } }))

async function complete(port: number, messages: readonly object[]): Promise<readonly Chunk[]> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fake-a", stream: true, messages, tools }),
  })
  const body = await response.text()
  return body
    .split("\n\n")
    .map((frame) => frame.replace(/^data: /, ""))
    .filter((data) => data.startsWith("{"))
    .map((data) => JSON.parse(data) as Chunk)
}

const toolCalls = (chunks: readonly Chunk[]) =>
  chunks.flatMap((chunk) => chunk.choices.flatMap((choice) => choice.delta.tool_calls ?? []))
const finish = (chunks: readonly Chunk[]) =>
  chunks
    .flatMap((chunk) => chunk.choices.map((choice) => choice.finish_reason))
    .filter((reason) => reason !== null)
const content = (chunks: readonly Chunk[]) =>
  chunks.flatMap((chunk) => chunk.choices.map((choice) => choice.delta.content ?? "")).join("")

describe("fake provider", async () => {
  const logFile = join(scratch, "provider.jsonl")
  const provider = await startFakeProvider({ logFile, shellTool: "shell" })
  afterAll(() => provider.close())

  it("emits the push as an OpenAI streamed tool call to the shell tool", async () => {
    const chunks = await complete(provider.port, [{ role: "user", content: "E2E-PUSH please" }])

    const [call] = toolCalls(chunks)
    expect(call?.type).toBe("function")
    expect(call?.function.name).toBe("shell")
    expect(JSON.parse(call?.function.arguments ?? "{}").command).toBe(PUSH_COMMAND)
    expect(finish(chunks)).toEqual(["tool_calls"])
  })

  it.each(["status", "disable", "enable"])("emits ci_watch {action: %s}", async (action) => {
    const chunks = await complete(provider.port, [{ role: "user", content: `E2E-WATCH-${action}` }])

    const [call] = toolCalls(chunks)
    expect(call?.function.name).toBe("ci_watch")
    expect(JSON.parse(call?.function.arguments ?? "{}")).toEqual({ action })
  })

  it("answers an injected [ci-loop] report with plain text and logs it, never pushing again", async () => {
    const messages = [
      { role: "user", content: "E2E-PUSH please" },
      { role: "assistant", content: "pushed" },
      {
        role: "user",
        content: "[ci-loop] CI result for github.com/e2e/fixture · feature/e2e push `abc1234`:",
      },
    ]

    const chunks = await complete(provider.port, messages)

    expect(toolCalls(chunks)).toEqual([])
    expect(content(chunks)).toStartWith("E2E-ACK")
    const lines = readFileSync(logFile, "utf8").trim().split("\n")
    expect(JSON.parse(lines.at(-1) ?? "{}")).toMatchObject({ isReport: true, reply: { kind: "text" } })
  })

  it("ends the turn with text after a tool result instead of looping", async () => {
    const messages = [
      { role: "user", content: "E2E-PUSH please" },
      { role: "tool", tool_call_id: "call_e2e_1", content: "To https://github.com/e2e/fixture.git" },
    ]

    const chunks = await complete(provider.port, messages)

    expect(toolCalls(chunks)).toEqual([])
    expect(finish(chunks)).toEqual(["stop"])
  })
})
