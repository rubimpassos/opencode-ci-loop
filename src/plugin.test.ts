import { describe, expect, it } from "bun:test"
import type { Plugin } from "@opencode-ai/plugin"
import { CiLoopPlugin, isGitPush } from "./plugin.ts"

describe("isGitPush", () => {
  it.each([
    ["git push", true],
    ["git push origin main", true],
    ["git push --force-with-lease origin feat/x", true],
    ["cd backend && git push", true],
    ["git -C /repo push origin main", true],
    ["git add . && git commit -m 'x' && git push", true],
    ["git push --dry-run", false],
    ["git pull origin main", false],
    ["echo push", false],
    ["git status", false],
  ])("classifies %j as push=%p", (command, expected) => {
    expect(isGitPush(command)).toBe(expected)
  })
})

const TEST_PORT = 46021

function makeInstance(directory: string) {
  const input = { client: {}, directory } as unknown as Parameters<Plugin>[0]
  return CiLoopPlugin(input, {
    dashboard: { enabled: false, host: "127.0.0.1", port: TEST_PORT },
  })
}

describe("CiLoopPlugin shared state", () => {
  it("instances in the same process share one registry (toggle visible across instances)", async () => {
    const a = await makeInstance("/tmp/project-a")
    const b = await makeInstance("/tmp/project-b")
    const context = { sessionID: "ses_shared" } as Parameters<
      NonNullable<Awaited<ReturnType<Plugin>>["tool"]>[string]["execute"]
    >[1]

    try {
      await a.tool?.["ci_watch"]?.execute({ action: "disable" }, context)
      const status = await b.tool?.["ci_watch"]?.execute({ action: "status" }, context)

      expect(status).toContain("disabled")
    } finally {
      await a.dispose?.()
      await b.dispose?.()
    }
  })
})
