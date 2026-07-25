import { describe, expect, it } from "bun:test"
import type { Plugin } from "@opencode-ai/plugin"
import type { PanelSnapshot } from "./panel-types.ts"
import { acquireShared, CiLoopPlugin, isGitPush, releaseShared } from "./plugin.ts"
import type { DashboardServer } from "./server.ts"
import { type PluginConfig, PluginConfigSchema, type SessionState } from "./types.ts"

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

type Hooks = Awaited<ReturnType<Plugin>>
type Client = Parameters<Plugin>[0]["client"]
type AfterHook = NonNullable<Hooks["tool.execute.after"]>
type EventHook = NonNullable<Hooks["event"]>
type ToolExecute = NonNullable<Hooks["tool"]>[string]["execute"]

const SID = "ses_title"
const DIR = "/tmp/project-a"
const TITLE = "Fix the CI loop"

let nextPort = 46100

function testConfig(serveDashboard: boolean): PluginConfig {
  nextPort += 1
  return PluginConfigSchema.parse({
    dashboard: { enabled: serveDashboard, host: "127.0.0.1", port: nextPort },
  })
}

type ClientStub = { readonly client: Client; readonly getCalls: string[] }

/** Records every `session.get` so the tests can prove the title cache hits and misses. */
function recordingClient(options: { title?: string; rejects?: boolean } = {}): ClientStub {
  const getCalls: string[] = []
  const client = {
    session: {
      get: async ({ path }: { path: { id: string } }) => {
        getCalls.push(path.id)
        if (options.rejects === true) throw new Error("session not found")
        return { data: sessionInfo(path.id, options.title ?? TITLE) }
      },
    },
  } as unknown as Client
  return { client, getCalls }
}

function sessionInfo(sessionID: string, title: string) {
  return {
    id: sessionID,
    projectID: "prj_test",
    directory: DIR,
    title,
    version: "1.0.0",
    time: { created: 0, updated: 0 },
  }
}

function makeInstance(options: {
  readonly directory: string
  readonly config: PluginConfig
  readonly client?: Client
}): Promise<Hooks> {
  const input = {
    client: options.client ?? {},
    directory: options.directory,
  } as unknown as Parameters<Plugin>[0]
  return CiLoopPlugin(input, options.config)
}

/** Drains the microtask queue so the fire-and-forget title fetch has settled. */
async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve()
  }
}

/** Push output with no `To <remote>` line resolves to zero targets — no watch, no subprocess. */
async function firePush(hooks: Hooks, sessionID: string): Promise<void> {
  const input = {
    tool: "bash",
    sessionID,
    callID: "call_push",
    args: { command: "git push" },
  } as unknown as Parameters<AfterHook>[0]
  const output = { title: "", output: "pushed", metadata: {} } as unknown as Parameters<AfterHook>[1]
  await hooks["tool.execute.after"]?.(input, output)
  await flush()
}

async function fireEvent(hooks: Hooks, event: unknown): Promise<void> {
  await hooks.event?.({ event } as unknown as Parameters<EventHook>[0])
  await flush()
}

async function setWatch(hooks: Hooks, sessionID: string, action: "enable" | "disable"): Promise<void> {
  const context = { sessionID } as unknown as Parameters<ToolExecute>[1]
  await hooks.tool?.["ci_watch"]?.execute({ action }, context)
}

async function panelState(config: PluginConfig): Promise<PanelSnapshot> {
  const response = await fetch(`http://127.0.0.1:${config.dashboard.port}/panel/state`)
  return (await response.json()) as PanelSnapshot
}

async function sessionStates(config: PluginConfig): Promise<readonly SessionState[]> {
  const response = await fetch(`http://127.0.0.1:${config.dashboard.port}/state`)
  return (await response.json()) as readonly SessionState[]
}

/** Wraps the real method so the count proves a broadcast happened without faking the server. */
function spyBroadcasts(dashboard: DashboardServer): { count: number } {
  const spy = { count: 0 }
  const original = dashboard.broadcast.bind(dashboard)
  dashboard.broadcast = (snapshot) => {
    spy.count += 1
    original(snapshot)
  }
  return spy
}

function titlesOf(panel: PanelSnapshot): readonly (string | null)[] {
  return panel.sessions.map((session) => session.title)
}

describe("CiLoopPlugin shared state", () => {
  it("instances in the same process share one registry (toggle visible across instances)", async () => {
    const config = testConfig(false)
    const a = await makeInstance({ directory: "/tmp/project-a", config })
    const b = await makeInstance({ directory: "/tmp/project-b", config })
    const context = { sessionID: "ses_shared" } as unknown as Parameters<ToolExecute>[1]

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

describe("CiLoopPlugin session titles", () => {
  it("fetches the session title when a watch starts and shows it in /panel/state", async () => {
    const config = testConfig(true)
    const stub = recordingClient()
    const hooks = await makeInstance({ directory: DIR, config, client: stub.client })

    try {
      await firePush(hooks, SID)

      expect(stub.getCalls).toEqual([SID])
      const panel = await panelState(config)
      expect(
        panel.sessions.map((session) => ({ sessionID: session.sessionID, title: session.title })),
      ).toEqual([{ sessionID: SID, title: TITLE }])
    } finally {
      await hooks.dispose?.()
    }
  })

  it("refreshes the title on session.updated and re-broadcasts the panel", async () => {
    const config = testConfig(true)
    const stub = recordingClient()
    const hooks = await makeInstance({ directory: DIR, config, client: stub.client })

    try {
      await firePush(hooks, SID)

      await fireEvent(hooks, {
        type: "session.updated",
        properties: { info: sessionInfo(SID, "Renamed by opencode") },
      })

      expect(titlesOf(await panelState(config))).toEqual(["Renamed by opencode"])
    } finally {
      await hooks.dispose?.()
    }
  })

  it("re-broadcasts on session.updated only when the title actually changed", async () => {
    const config = testConfig(false)
    const stub = recordingClient()
    const hooks = await makeInstance({ directory: DIR, config, client: stub.client })

    try {
      await firePush(hooks, SID)
      const shared = acquireShared(config, stub.client)
      const spy = spyBroadcasts(shared.dashboard)

      try {
        await fireEvent(hooks, { type: "session.updated", properties: { info: sessionInfo(SID, TITLE) } })
        await fireEvent(hooks, { type: "session.updated", properties: { info: sessionInfo(SID, "Renamed") } })
        await fireEvent(hooks, { type: "session.updated", properties: { info: sessionInfo(SID, "Renamed") } })

        expect(spy.count).toBe(1)
      } finally {
        releaseShared(config.dashboard.port)
      }
    } finally {
      await hooks.dispose?.()
    }
  })

  it("falls back to a null title when session.get rejects", async () => {
    const config = testConfig(true)
    const stub = recordingClient({ rejects: true })
    const hooks = await makeInstance({ directory: DIR, config, client: stub.client })

    try {
      await setWatch(hooks, SID, "enable")
      await firePush(hooks, SID)

      expect(stub.getCalls).toEqual([SID])
      expect(titlesOf(await panelState(config))).toEqual([null])
    } finally {
      await hooks.dispose?.()
    }
  })

  it("does not re-fetch a title already cached", async () => {
    const config = testConfig(false)
    const stub = recordingClient()
    const hooks = await makeInstance({ directory: DIR, config, client: stub.client })

    try {
      await firePush(hooks, SID)
      await firePush(hooks, SID)

      expect(stub.getCalls).toEqual([SID])
    } finally {
      await hooks.dispose?.()
    }
  })

  it("drops the cached title on session.deleted", async () => {
    const config = testConfig(false)
    const stub = recordingClient()
    const hooks = await makeInstance({ directory: DIR, config, client: stub.client })

    try {
      await firePush(hooks, SID)
      await fireEvent(hooks, { type: "session.deleted", properties: { info: sessionInfo(SID, TITLE) } })
      await firePush(hooks, SID)

      expect(stub.getCalls).toEqual([SID, SID])
    } finally {
      await hooks.dispose?.()
    }
  })

  it("keeps /state free of a title field", async () => {
    const config = testConfig(true)
    const stub = recordingClient()
    const hooks = await makeInstance({ directory: DIR, config, client: stub.client })

    try {
      await firePush(hooks, SID)

      const states = await sessionStates(config)
      expect(states).toHaveLength(1)
      expect(Object.keys(states[0] ?? {}).sort()).toEqual([
        "directory",
        "enabled",
        "sessionID",
        "watch",
        "watches",
      ])
    } finally {
      await hooks.dispose?.()
    }
  })
})
