import { describe, expect, it } from "bun:test"
import type { Plugin } from "@opencode-ai/plugin"
import { CiLoopPlugin, isGitPush, notifyPhase, resolveSessionModel } from "./plugin.ts"
import type { CommitSha, PrInfo, SessionId, Watch } from "./types.ts"

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

type Client = Parameters<typeof notifyPhase>[0]

function clientWithMessages(messages: ReadonlyArray<{ info: Record<string, unknown> }>): Client {
  return { session: { messages: async () => ({ data: messages }) } } as unknown as Client
}

describe("resolveSessionModel", () => {
  it("returns the last assistant message's model", async () => {
    const client = clientWithMessages([
      { info: { role: "assistant", providerID: "anthropic", modelID: "claude-fable-5" } },
      { info: { role: "user" } },
      { info: { role: "assistant", providerID: "openai", modelID: "gpt-5.6" } },
      { info: { role: "user" } },
    ])
    expect(await resolveSessionModel(client, "ses_x" as SessionId)).toEqual({
      providerID: "openai",
      modelID: "gpt-5.6",
    })
  })

  it("returns undefined when there is no assistant message yet", async () => {
    const client = clientWithMessages([{ info: { role: "user" } }])
    expect(await resolveSessionModel(client, "ses_x" as SessionId)).toBeUndefined()
  })

  it("returns undefined instead of throwing when the messages request fails", async () => {
    const client = {
      session: {
        messages: async () => {
          throw new Error("network down")
        },
      },
    } as unknown as Client
    expect(await resolveSessionModel(client, "ses_x" as SessionId)).toBeUndefined()
  })
})

function makePr(overrides: Partial<PrInfo> = {}): PrInfo {
  return {
    number: 12,
    title: "feat: nova feature",
    url: "https://github.com/o/r/pull/12",
    isDraft: false,
    state: "OPEN",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    ...overrides,
  }
}

function doneWatch(runsSucceed: boolean, pr: PrInfo | null = null): Watch {
  const sha = "abc12345def0" as CommitSha
  return {
    sha,
    branch: "develop",
    startedAt: Date.now(),
    phase: {
      kind: "done",
      report: {
        sha,
        branch: "develop",
        runs: runsSucceed
          ? [
              {
                id: 1,
                name: "CI",
                workflowName: "CI",
                status: "completed",
                conclusion: "success",
                url: "https://x",
                branch: "develop",
              },
            ]
          : [],
        failedLogs: [],
        pr,
      },
    },
  }
}

type PromptBody = { model?: { providerID: string; modelID: string }; parts: unknown }
type ToastBody = { title: string; message: string; variant: string }

function recordingClient(messages: ReadonlyArray<{ info: Record<string, unknown> }>): {
  client: Client
  prompts: PromptBody[]
  toasts: ToastBody[]
} {
  const prompts: PromptBody[] = []
  const toasts: ToastBody[] = []
  const client = {
    tui: {
      showToast: async (opts: { body: ToastBody }) => {
        toasts.push(opts.body)
      },
    },
    session: {
      messages: async () => ({ data: messages }),
      prompt: async (opts: { body: PromptBody }) => {
        prompts.push(opts.body)
        return { data: {} }
      },
    },
  } as unknown as Client
  return { client, prompts, toasts }
}

describe("notifyPhase done toast", () => {
  it("keeps the CI-only text when the branch has no PR", async () => {
    const { client, toasts } = recordingClient([])

    await notifyPhase(client, new Map(), "ses_ci" as SessionId, doneWatch(true))

    expect(toasts[0]?.message).toBe("CI green (1 checks)")
  })

  it("appends ready-to-merge status when the branch has a ready PR", async () => {
    const { client, toasts } = recordingClient([])

    await notifyPhase(client, new Map(), "ses_ready" as SessionId, doneWatch(true, makePr()))

    expect(toasts[0]?.message).toBe("CI green (1 checks) · PR #12 ready to merge")
  })

  it("appends the blocker count when the branch PR is not ready", async () => {
    const { client, toasts } = recordingClient([])

    await notifyPhase(
      client,
      new Map(),
      "ses_blocked" as SessionId,
      doneWatch(true, makePr({ isDraft: true })),
    )

    expect(toasts[0]?.message).toBe("CI green (1 checks) · PR #12 blocked: 1 issue")
  })
})

describe("notifyPhase model preservation", () => {
  it("injects the CI report on the session's last-used model", async () => {
    const { client, prompts } = recordingClient([
      { info: { role: "assistant", providerID: "openai", modelID: "gpt-5.6" } },
    ])

    await notifyPhase(client, new Map(), "ses_x" as SessionId, doneWatch(true))

    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.model).toEqual({ providerID: "openai", modelID: "gpt-5.6" })
  })

  it("omits the model (falls back to the agent default) when no assistant message exists", async () => {
    const { client, prompts } = recordingClient([])

    await notifyPhase(client, new Map(), "ses_y" as SessionId, doneWatch(true))

    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.model).toBeUndefined()
  })
})
