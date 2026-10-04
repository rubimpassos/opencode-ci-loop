import { describe, expect, it } from "bun:test"
import type { CiLoopHost, HostPrompt, HostToast, SessionModel } from "./host-port.ts"
import type { Locale } from "./i18n.ts"
import { clearSessionNotifications, type NotifyContext, notifyPhase, notifyReviewUpdate } from "./notify.ts"
import { resolveSessionContext } from "./session-context.ts"
import {
  type CiReport,
  type CommitSha,
  type NewCommentEvent,
  PluginConfigSchema,
  type PrInfo,
  type ReviewComment,
  type ReviewDelta,
  type ReviewEndReason,
  type ReviewSnapshot,
  type ReviewThread,
  type SessionId,
  type Watch,
  type WatchPhase,
  type WorkflowRun,
} from "./types.ts"

const SID = "ses_notify" as SessionId
const SHA = "abc12345def0" as CommitSha

type FakeMessage = { info: Record<string, unknown>; parts?: ReadonlyArray<{ type: string; text: string }> }
type PromptBody = { model?: SessionModel; parts: ReadonlyArray<{ type: string; text: string }> }

/** The host's view of a conversation: newest assistant model and newest user text. */
function contextOf(messages: readonly FakeMessage[]): { model?: SessionModel; lastUserText: string } {
  const assistant = messages.findLast((message) => message.info["role"] === "assistant")
  const user = messages.findLast((message) => message.info["role"] === "user")
  const providerID = assistant?.info["providerID"]
  const modelID = assistant?.info["modelID"]
  const lastUserText = (user?.parts ?? []).map((part) => part.text).join("\n")
  return typeof providerID === "string" && typeof modelID === "string"
    ? { model: { providerID, modelID }, lastUserText }
    : { lastUserText }
}

function recordingHost(initial: readonly FakeMessage[] = []): {
  host: CiLoopHost
  prompts: PromptBody[]
  toasts: HostToast[]
  calls: { messages: number }
  setMessages: (next: readonly FakeMessage[]) => void
} {
  let messages = initial
  const prompts: PromptBody[] = []
  const toasts: HostToast[] = []
  const calls = { messages: 0 }
  const host: CiLoopHost = {
    sessionScope: "global",
    getSessionTitle: async () => undefined,
    readSessionContext: async () => {
      calls.messages += 1
      return contextOf(messages)
    },
    prompt: async (_sessionID, content: HostPrompt) => {
      prompts.push({
        ...(content.model && { model: content.model }),
        parts: [{ type: "text", text: content.text }],
      })
    },
    toast: async (content) => {
      toasts.push(content)
    },
    log: async () => {},
  }
  return {
    host,
    prompts,
    toasts,
    calls,
    setMessages: (next) => {
      messages = next
    },
  }
}

function makeCtx(host: CiLoopHost, language = "auto"): NotifyContext {
  return {
    host,
    notifications: new Set(),
    locales: new Map<SessionId, Locale>(),
    config: PluginConfigSchema.parse({ language }),
  }
}

function promptText(prompt: PromptBody | undefined): string {
  return prompt?.parts[0]?.text ?? ""
}

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
    commitCount: 3,
    checks: [],
    ...overrides,
  }
}

function makeReport(pr: PrInfo | null = null, review: ReviewSnapshot | null = null): CiReport {
  return {
    sha: SHA,
    branch: "develop",
    repo: "github.com/o/r",
    sourceKind: "session",
    directory: "/repo",
    runs: [
      {
        id: 1,
        name: "CI",
        workflowName: "CI",
        status: "completed",
        conclusion: "success",
        url: "https://x",
        branch: "develop",
      },
    ],
    failedLogs: [],
    pr,
    ruleFailures: [],
    review,
  }
}

function makeWatch(phase: WatchPhase, sha: CommitSha = SHA): Watch {
  return {
    sha,
    branch: "develop",
    repo: "github.com/o/r",
    repoUrl: "https://github.com/o/r",
    directory: "/repo",
    sourceKind: "session",
    startedAt: Date.now(),
    phase,
  }
}

function doneWatch(pr: PrInfo | null = null): Watch {
  return makeWatch({ kind: "done", report: makeReport(pr) })
}

function makeComment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    databaseId: 100,
    author: "alice",
    body: "please fix this",
    path: "src/a.ts",
    line: 10,
    url: "https://github.com/o/r/pull/12#discussion_r100",
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
    ...overrides,
  }
}

function makeThread(overrides: Partial<ReviewThread> = {}): ReviewThread {
  return { id: "T1", isResolved: false, isOutdated: false, comments: [makeComment()], ...overrides }
}

function makeSnapshot(overrides: Partial<ReviewSnapshot> = {}): ReviewSnapshot {
  return {
    prNumber: 12,
    prState: "OPEN",
    merged: false,
    reviewDecision: null,
    mergeStateStatus: "CLEAN",
    threads: [],
    reviews: [],
    comments: [],
    fetchedAt: 0,
    ...overrides,
  }
}

const EMPTY_DELTA: ReviewDelta = {
  newComments: [],
  newReviews: [],
  threadsResolved: [],
  threadsUnresolved: [],
  decisionChange: null,
  mergeStateChange: null,
  unresolved: { from: 0, to: 0 },
}

function deltaWith(overrides: Partial<ReviewDelta>): ReviewDelta {
  return { ...EMPTY_DELTA, ...overrides }
}

function commentEvent(comment: ReviewComment): NewCommentEvent {
  return { comment, threadId: "T1", isResolved: false, path: comment.path, line: comment.line }
}

function reviewingWatch(
  delta: ReviewDelta,
  options: { snapshot?: ReviewSnapshot; pr?: PrInfo | null; sha?: CommitSha } = {},
): Watch {
  const snapshot = options.snapshot ?? makeSnapshot()
  return makeWatch(
    { kind: "reviewing", report: makeReport(options.pr ?? makePr(), snapshot), snapshot, delta },
    options.sha ?? SHA,
  )
}

function endedWatch(
  reason: ReviewEndReason,
  delta: ReviewDelta = deltaWith({ unresolved: { from: 2, to: 0 } }),
): Watch {
  const snapshot = makeSnapshot()
  return makeWatch({ kind: "review-ended", report: makeReport(makePr(), snapshot), snapshot, delta, reason })
}

describe("resolveSessionContext", () => {
  it("falls back to en without a model when the messages request fails", async () => {
    const host: CiLoopHost = {
      ...recordingHost().host,
      readSessionContext: async () => {
        throw new Error("network down")
      },
    }
    const locales = new Map<SessionId, Locale>()
    const result = await resolveSessionContext({ ...makeCtx(host), locales }, SID)
    expect(result.model).toBeUndefined()
    expect(result.locale).toBe("en")
    expect(locales.size).toBe(0)
  })

  it("detects the locale from the last user message's text parts and caches it", async () => {
    const { host } = recordingHost([
      { info: { role: "user" }, parts: [{ type: "text", text: "você pode corrigir isso por favor" }] },
    ])
    const locales = new Map<SessionId, Locale>()
    const result = await resolveSessionContext({ ...makeCtx(host), locales }, SID)
    expect(result.locale).toBe("pt-BR")
    expect(locales.get(SID)).toBe("pt-BR")
  })

  it("skips detection when the config language is explicit", async () => {
    const { host } = recordingHost([
      { info: { role: "user" }, parts: [{ type: "text", text: "você pode corrigir isso por favor" }] },
    ])
    const locales = new Map<SessionId, Locale>()
    const result = await resolveSessionContext({ ...makeCtx(host, "en"), locales }, SID)
    expect(result.locale).toBe("en")
    expect(locales.size).toBe(0)
  })
})

describe("notifyPhase done toast", () => {
  it("keeps the CI-only text when the branch has no PR", async () => {
    const { host, toasts } = recordingHost()

    await notifyPhase(makeCtx(host), "ses_ci" as SessionId, doneWatch())

    expect(toasts[0]?.message).toBe(
      "CI green (1 checks) · github.com/o/r · develop — current branch of this session",
    )
  })

  it("appends ready-to-merge status when the branch has a ready PR", async () => {
    const { host, toasts } = recordingHost()

    await notifyPhase(makeCtx(host), "ses_ready" as SessionId, doneWatch(makePr()))

    expect(toasts[0]?.message).toBe(
      "CI green (1 checks) · PR #12 ready to merge · github.com/o/r · develop — current branch of this session",
    )
  })

  it("appends the blocker count when the branch PR is not ready", async () => {
    const { host, toasts } = recordingHost()

    await notifyPhase(makeCtx(host), "ses_blocked" as SessionId, doneWatch(makePr({ isDraft: true })))

    expect(toasts[0]?.message).toBe(
      "CI green (1 checks) · PR #12 blocked: 1 issue · github.com/o/r · develop — current branch of this session",
    )
  })

  it("does not dedupe equal phases from different watched branches", async () => {
    const { host, toasts } = recordingHost()
    const ctx = makeCtx(host)
    const first = makeWatch({ kind: "waiting" })
    const second = { ...first, branch: "release" } satisfies Watch

    await notifyPhase(ctx, "ses_multi" as SessionId, first)
    await notifyPhase(ctx, "ses_multi" as SessionId, second)

    expect(toasts).toHaveLength(2)
  })

  it("does not toast or prompt after its watch generation is aborted", async () => {
    const { host, prompts, toasts } = recordingHost()
    const controller = new AbortController()
    controller.abort()

    await notifyPhase(makeCtx(host), "ses_stale" as SessionId, doneWatch(), controller.signal)

    expect(toasts).toEqual([])
    expect(prompts).toEqual([])
  })
})

describe("notifyPhase model preservation", () => {
  it("injects the CI report on the session's last-used model", async () => {
    const { host, prompts } = recordingHost([
      { info: { role: "assistant", providerID: "openai", modelID: "gpt-5.6" } },
    ])

    await notifyPhase(makeCtx(host), "ses_x" as SessionId, doneWatch())

    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.model).toEqual({ providerID: "openai", modelID: "gpt-5.6" })
  })

  it("omits the model (falls back to the agent default) when no assistant message exists", async () => {
    const { host, prompts } = recordingHost()

    await notifyPhase(makeCtx(host), "ses_y" as SessionId, doneWatch())

    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.model).toBeUndefined()
  })
})

describe("notifyPhase reviewing", () => {
  it("injects one batched prompt containing every unseen delta item", async () => {
    const { host, prompts, toasts } = recordingHost()
    const ctx = makeCtx(host)
    const delta = deltaWith({
      newComments: [
        commentEvent(makeComment({ databaseId: 100, author: "alice", body: "fix the null check" })),
        commentEvent(makeComment({ databaseId: 101, author: "Copilot", body: "consider a guard clause" })),
      ],
      unresolved: { from: 1, to: 2 },
    })

    await notifyPhase(ctx, SID, reviewingWatch(delta))

    expect(toasts).toHaveLength(1)
    expect(prompts).toHaveLength(1)
    const text = promptText(prompts[0])
    expect(text).toContain("[ci-loop] Review update for github.com/o/r · PR #12 (no CI change):")
    expect(text).toContain("fix the null check")
    expect(text).toContain("consider a guard clause")
  })

  it("is silent when every delta item was already seen", async () => {
    const { host, prompts, toasts } = recordingHost()
    const ctx = makeCtx(host)
    const delta = deltaWith({ newComments: [commentEvent(makeComment({ databaseId: 100 }))] })

    await notifyPhase(ctx, SID, reviewingWatch(delta))
    await notifyPhase(ctx, SID, reviewingWatch(delta))

    expect(toasts).toHaveLength(1)
    expect(prompts).toHaveLength(1)
  })

  it("renders only unseen items when the delta is partially seen", async () => {
    const { host, prompts } = recordingHost()
    const ctx = makeCtx(host)
    const seen = commentEvent(makeComment({ databaseId: 100, body: "old body one" }))
    const fresh = commentEvent(makeComment({ databaseId: 101, body: "brand new body" }))

    await notifyPhase(ctx, SID, reviewingWatch(deltaWith({ newComments: [seen] })))
    await notifyPhase(ctx, SID, reviewingWatch(deltaWith({ newComments: [seen, fresh] })))

    expect(prompts).toHaveLength(2)
    const text = promptText(prompts[1])
    expect(text).toContain("brand new body")
    expect(text).not.toContain("old body one")
  })

  it("includes the unresolved-conversation blocker computed from the snapshot", async () => {
    const { host, prompts } = recordingHost()
    const ctx = makeCtx(host)
    const snapshot = makeSnapshot({ threads: [makeThread()] })
    const delta = deltaWith({
      newComments: [commentEvent(makeComment({ databaseId: 100 }))],
      unresolved: { from: 0, to: 1 },
    })

    await notifyPhase(ctx, SID, reviewingWatch(delta, { snapshot }))

    expect(promptText(prompts[0])).toContain("1 unresolved review conversations")
  })

  it("keeps repo+PR fingerprints across watch replacement (new sha)", async () => {
    const { host, prompts, toasts } = recordingHost()
    const ctx = makeCtx(host)
    const delta = deltaWith({ newComments: [commentEvent(makeComment({ databaseId: 100 }))] })

    await notifyPhase(ctx, SID, reviewingWatch(delta, { sha: "aaaa1111bbbb" as CommitSha }))
    await notifyPhase(ctx, SID, reviewingWatch(delta, { sha: "cccc2222dddd" as CommitSha }))

    expect(prompts).toHaveLength(1)
    expect(toasts).toHaveLength(1)
  })
})

describe("notifyReviewUpdate (mid-CI)", () => {
  it("injects message A with the session model and dedupes the later reviewing phase", async () => {
    const { host, prompts, toasts } = recordingHost([
      { info: { role: "assistant", providerID: "openai", modelID: "gpt-5.6" } },
    ])
    const ctx = makeCtx(host)
    const comment = makeComment({ databaseId: 100, author: "Copilot", body: "extract this helper" })
    const delta = deltaWith({ newComments: [commentEvent(comment)] })
    const snapshot = makeSnapshot({ threads: [makeThread({ comments: [comment] })] })
    const runs: WorkflowRun[] = [
      {
        id: 1,
        name: "CI",
        workflowName: "CI",
        status: "in_progress",
        conclusion: null,
        url: "https://x",
        branch: "develop",
      },
    ]

    await notifyReviewUpdate(ctx, SID, makeWatch({ kind: "running", runs }), { delta, snapshot, runs })

    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.model).toEqual({ providerID: "openai", modelID: "gpt-5.6" })
    const text = promptText(prompts[0])
    expect(text).toContain("CI still running: 0/1 completed")
    expect(text).toContain("extract this helper")

    await notifyPhase(ctx, SID, reviewingWatch(delta, { snapshot }))

    expect(prompts).toHaveLength(1)
    expect(toasts).toHaveLength(1)
  })
})

describe("notifyPhase review-ended", () => {
  it("toasts and injects the final message when the watch ends ready", async () => {
    const { host, prompts, toasts } = recordingHost()

    await notifyPhase(makeCtx(host), SID, endedWatch("ready"))

    expect(toasts[0]?.message).toBe("All threads resolved — PR #12 ready to merge")
    expect(prompts).toHaveLength(1)
    expect(promptText(prompts[0])).toContain("[review watch ended]")
  })

  it.each([
    ["merged", "PR #12 merged — review watch ended"],
    ["closed", "PR #12 closed — review watch ended"],
    ["idle-timeout", "Review watch idle — stopped watching PR #12"],
  ] as const)("only toasts when the watch ends %s", async (reason, expected) => {
    const { host, prompts, toasts } = recordingHost()

    await notifyPhase(makeCtx(host), SID, endedWatch(reason))

    expect(toasts).toHaveLength(1)
    expect(toasts[0]?.message).toBe(expected)
    expect(prompts).toHaveLength(0)
  })

  it("fires the end notification only once", async () => {
    const { host, prompts, toasts } = recordingHost()
    const ctx = makeCtx(host)

    await notifyPhase(ctx, SID, endedWatch("ready"))
    await notifyPhase(ctx, SID, endedWatch("ready"))

    expect(toasts).toHaveLength(1)
    expect(prompts).toHaveLength(1)
  })
})

describe("review toast selection", () => {
  it("uses the Copilot toast for bot-only new comments", async () => {
    const { host, toasts } = recordingHost()
    const delta = deltaWith({
      newComments: [
        commentEvent(makeComment({ databaseId: 100, author: "Copilot" })),
        commentEvent(makeComment({ databaseId: 101, author: "copilot-pull-request-reviewer" })),
      ],
    })

    await notifyPhase(makeCtx(host), SID, reviewingWatch(delta))

    expect(toasts[0]?.message).toBe("Copilot review: 2 comments · PR #12")
  })

  it("uses the single-author toast for one human comment", async () => {
    const { host, toasts } = recordingHost()
    const delta = deltaWith({
      newComments: [commentEvent(makeComment({ databaseId: 100, author: "alice" }))],
    })

    await notifyPhase(makeCtx(host), SID, reviewingWatch(delta))

    expect(toasts[0]?.message).toBe("New comment from alice · PR #12")
  })

  it("falls back to the generic review-update toast for mixed activity", async () => {
    const { host, toasts } = recordingHost()
    const delta = deltaWith({
      newComments: [
        commentEvent(makeComment({ databaseId: 100, author: "alice" })),
        commentEvent(makeComment({ databaseId: 101, author: "Copilot" })),
      ],
    })

    await notifyPhase(makeCtx(host), SID, reviewingWatch(delta))

    expect(toasts[0]?.message).toContain("Review update:")
    expect(toasts[0]?.message).toContain("PR #12")
  })
})

describe("notify locale", () => {
  it("renders pt-BR when the config language is pt-BR", async () => {
    const { host, prompts } = recordingHost()
    const ctx = makeCtx(host, "pt-BR")
    const delta = deltaWith({ newComments: [commentEvent(makeComment({ databaseId: 100 }))] })

    await notifyPhase(ctx, SID, reviewingWatch(delta))

    expect(promptText(prompts[0])).toContain(
      "[ci-loop] Atualização de review para github.com/o/r · PR #12 (sem mudança no CI):",
    )
  })

  it("detects pt-BR from the last user message and serves later calls from the cache", async () => {
    const rec = recordingHost([
      { info: { role: "user" }, parts: [{ type: "text", text: "você pode corrigir isso por favor" }] },
    ])
    const ctx = makeCtx(rec.host)
    const first = deltaWith({ newComments: [commentEvent(makeComment({ databaseId: 100 }))] })
    const second = deltaWith({ newComments: [commentEvent(makeComment({ databaseId: 101 }))] })

    await notifyPhase(ctx, SID, reviewingWatch(first))

    expect(promptText(rec.prompts[0])).toContain("Atualização de review")
    expect(ctx.locales.get(SID)).toBe("pt-BR")

    rec.setMessages([{ info: { role: "user" }, parts: [{ type: "text", text: "please fix it now" }] }])
    await notifyPhase(ctx, SID, reviewingWatch(second))

    expect(promptText(rec.prompts[1])).toContain("Atualização de review")
    expect(rec.calls.messages).toBe(2)
  })
})

describe("clearSessionNotifications", () => {
  it("removes only fingerprints and the locale entry owned by the deleted session", () => {
    const notifications = new Set([
      "ses_a\0github.com/o/r\0refs/heads/main\0abc\0waiting",
      "ses_a\0github.com/o/r\0pr12\0comment:100:2026-07-01T00:00:00Z",
      "ses_b\0github.com/o/r\0refs/heads/main\0abc\0waiting",
    ])
    const locales = new Map<SessionId, Locale>([
      ["ses_a" as SessionId, "pt-BR"],
      ["ses_b" as SessionId, "en"],
    ])

    clearSessionNotifications(notifications, "ses_a" as SessionId, locales)

    expect([...notifications]).toEqual(["ses_b\0github.com/o/r\0refs/heads/main\0abc\0waiting"])
    expect([...locales.keys()]).toEqual(["ses_b" as SessionId])
  })
})
