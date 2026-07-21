import { describe, expect, it } from "bun:test"
import type { Plugin } from "@opencode-ai/plugin"
import {
  CiLoopPlugin,
  clearSessionNotifications,
  isGitPush,
  notifyPhase,
  resolveSessionModel,
} from "./plugin.ts"
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
    repo: "github.com/o/r",
    repoUrl: "https://github.com/o/r",
    directory: "/repo",
    sourceKind: "session",
    startedAt: Date.now(),
    phase: {
      kind: "done",
      report: {
        sha,
        branch: "develop",
        repo: "github.com/o/r",
        sourceKind: "session",
        directory: "/repo",
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

    await notifyPhase(client, new Set(), "ses_ci" as SessionId, doneWatch(true))

    expect(toasts[0]?.message).toBe(
      "CI green (1 checks) · github.com/o/r · develop — current branch of this session",
    )
  })

  it("appends ready-to-merge status when the branch has a ready PR", async () => {
    const { client, toasts } = recordingClient([])

    await notifyPhase(client, new Set(), "ses_ready" as SessionId, doneWatch(true, makePr()))

    expect(toasts[0]?.message).toBe(
      "CI green (1 checks) · PR #12 ready to merge · github.com/o/r · develop — current branch of this session",
    )
  })

  it("appends the blocker count when the branch PR is not ready", async () => {
    const { client, toasts } = recordingClient([])

    await notifyPhase(
      client,
      new Set(),
      "ses_blocked" as SessionId,
      doneWatch(true, makePr({ isDraft: true })),
    )

    expect(toasts[0]?.message).toBe(
      "CI green (1 checks) · PR #12 blocked: 1 issue · github.com/o/r · develop — current branch of this session",
    )
  })

  it("does not dedupe equal phases from different watched branches", async () => {
    const { client, toasts } = recordingClient([])
    const notifications = new Set<string>()
    const first = { ...doneWatch(true), phase: { kind: "waiting" } } satisfies Watch
    const second = { ...first, branch: "release" } satisfies Watch

    await notifyPhase(client, notifications, "ses_multi" as SessionId, first)
    await notifyPhase(client, notifications, "ses_multi" as SessionId, second)

    expect(toasts).toHaveLength(2)
  })

  it("does not toast or prompt after its watch generation is aborted", async () => {
    const { client, prompts, toasts } = recordingClient([])
    const controller = new AbortController()
    controller.abort()

    await notifyPhase(client, new Set(), "ses_stale" as SessionId, doneWatch(true), controller.signal)

    expect(toasts).toEqual([])
    expect(prompts).toEqual([])
  })
})

describe("notifyPhase model preservation", () => {
  it("injects the CI report on the session's last-used model", async () => {
    const { client, prompts } = recordingClient([
      { info: { role: "assistant", providerID: "openai", modelID: "gpt-5.6" } },
    ])

    await notifyPhase(client, new Set(), "ses_x" as SessionId, doneWatch(true))

    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.model).toEqual({ providerID: "openai", modelID: "gpt-5.6" })
  })

  it("omits the model (falls back to the agent default) when no assistant message exists", async () => {
    const { client, prompts } = recordingClient([])

    await notifyPhase(client, new Set(), "ses_y" as SessionId, doneWatch(true))

    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.model).toBeUndefined()
  })
})

describe("clearSessionNotifications", () => {
  it("removes only fingerprints owned by the deleted session", () => {
    const notifications = new Set([
      "ses_a\0github.com/o/r\0refs/heads/main\0abc\0waiting",
      "ses_a\0github.com/o/r\0refs/heads/dev\0def\0done",
      "ses_b\0github.com/o/r\0refs/heads/main\0abc\0waiting",
    ])

    clearSessionNotifications(notifications, "ses_a" as SessionId)

    expect([...notifications]).toEqual(["ses_b\0github.com/o/r\0refs/heads/main\0abc\0waiting"])
  })
})
