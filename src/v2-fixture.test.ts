import { expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { Agent, Location } from "@opencode/plugin"
import type { ToolEditor } from "@opencode/plugin/promise/tool"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import type { V2SessionApi } from "./host-v2.ts"
import type { V2Context } from "./plugin-v2.ts"

export type AfterEvent = Extract<Parameters<Parameters<V2Context["tool"]["hook"]>[1]>[0], { status: string }>
export type ServerEvent =
  ReturnType<V2Context["event"]["subscribe"]> extends AsyncIterable<infer E> ? E : never
export const SID = Session.ID.make("ses_v2_fixture")
export const toolContext = {
  sessionID: SID,
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_fixture"),
  id: Tool.CallID.make("call_fixture"),
  signal: new AbortController().signal,
  progress: async () => {},
}

/** In-memory SDK seam: model switches affect reads and queued prompts capture the selected model. */
export class SessionFake {
  info: Awaited<ReturnType<V2SessionApi["get"]>>
  messages: Awaited<ReturnType<V2SessionApi["context"]>> = []
  readonly prompts: {
    readonly input: Parameters<V2SessionApi["prompt"]>[0]
    readonly model: SessionFake["info"]["model"]
  }[] = []
  readonly signals: (AbortSignal | undefined)[] = []
  readonly switches: Parameters<V2SessionApi["switchModel"]>[0][] = []
  constructor(directory: string) {
    this.info = {
      id: SID,
      projectID: "project",
      title: "fixture",
      location: { directory },
      model: { providerID: "fallback", id: "default", variant: "high" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 0, updated: 0 },
    }
  }
  readonly api: V2SessionApi = {
    get: async (_input, options) => {
      this.signals.push(options?.signal)
      options?.signal?.throwIfAborted()
      return this.info
    },
    context: async (_input, options) => {
      this.signals.push(options?.signal)
      options?.signal?.throwIfAborted()
      return this.messages
    },
    switchModel: async (input, options) => {
      options?.signal?.throwIfAborted()
      this.switches.push(input)
      this.info = { ...this.info, model: input.model }
    },
    prompt: async (input, options) => {
      this.signals.push(options?.signal)
      options?.signal?.throwIfAborted()
      this.prompts.push({ input, model: this.info.model })
      return {
        id: "inbox_fixture",
        sessionID: input.sessionID,
        type: "user",
        time: { created: 0 },
        payload: { text: input.text },
        delivery: input.delivery ?? "steer",
      }
    },
  }
}

export function v2Fixture() {
  const directory = mkdtempSync("/tmp/opencode/ci-v2-test-")
  const previousStateHome = process.env["XDG_STATE_HOME"]
  process.env["XDG_STATE_HOME"] = directory
  const reservation = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() })
  const port = reservation.port
  reservation.stop(true)
  if (port === undefined) throw new TypeError("Expected a TCP port")
  const session = new SessionFake(directory)
  const tools = new Map<string, ReturnType<ToolEditor["list"]>[number]>()
  let after: ((event: AfterEvent) => Promise<void> | void) | undefined
  let next = Promise.withResolvers<ServerEvent | undefined>()
  let consumed = Promise.withResolvers<void>()
  let aborted = false
  const editor: ToolEditor = {
    list: () => [...tools.values()],
    get: (id) => tools.get(id),
    namespace: () => {},
    add: (tool) => {
      tools.set(tool.name, { ...tool, id: tool.name })
    },
    update: (id, update) => {
      const tool = tools.get(id)
      if (tool) update(tool)
    },
    remove: (id) => {
      tools.delete(id)
    },
  }
  const ctx: V2Context = {
    app: { name: "opencode", version: "2.0.22", channel: "latest" },
    location: Location.Info.make({
      directory: Location.Ref.fields.directory.make("/different/plugin/location"),
      project: {
        id: Location.Info.fields.project.fields.id.make("project"),
        directory: Location.Ref.fields.directory.make(directory),
        canonical: Location.Ref.fields.directory.make(directory),
      },
    }),
    options: { dashboard: { port }, initialDelayMs: 60_000, review: { enabled: false } },
    session: session.api,
    tool: {
      hook: async (name, callback) => {
        if (name !== "execute.after") throw new TypeError(`Unexpected hook: ${name}`)
        after = (event) => callback(event)
        return {
          dispose: async () => {
            after = undefined
          },
        }
      },
      transform: async (transform) => {
        transform(editor)
        return {
          dispose: async () => {
            tools.clear()
          },
        }
      },
    },
    event: {
      async *subscribe(options) {
        const stop = () => {
          aborted = true
          next.resolve(undefined)
        }
        options?.signal?.addEventListener("abort", stop, { once: true })
        try {
          while (!options?.signal?.aborted) {
            const event = await next.promise
            next = Promise.withResolvers()
            if (!event) return
            yield event
            consumed.resolve()
          }
        } finally {
          options?.signal?.removeEventListener("abort", stop)
        }
      },
    },
  }
  return {
    ctx,
    session,
    port,
    directory,
    tools,
    get aborted() {
      return aborted
    },
    async after(event: AfterEvent) {
      if (!after) throw new TypeError("execute.after was not registered")
      await after(event)
    },
    async send(event: ServerEvent) {
      consumed = Promise.withResolvers()
      next.resolve(event)
      await consumed.promise
    },
    async execute(input: unknown) {
      const tool = tools.get("ci_watch")
      if (!tool) throw new TypeError("ci_watch was not registered")
      return tool.execute(input, toolContext)
    },
    [Symbol.dispose]() {
      if (previousStateHome === undefined) delete process.env["XDG_STATE_HOME"]
      else process.env["XDG_STATE_HOME"] = previousStateHome
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

it("queues with the selected model when the fake session switches models", async () => {
  // Given the SDK-shaped in-memory session.
  const fake = new SessionFake("/fixture")
  await fake.api.switchModel({ sessionID: SID, model: { providerID: "fixture", id: "selected" } })
  // When a prompt is admitted.
  const item = await fake.api.prompt({ sessionID: SID, text: "payload", delivery: "queue" })
  // Then delivery and model selection are independent of the initial fallback.
  expect(item.delivery).toBe("queue")
  expect(fake.prompts[0]?.model).toEqual({ providerID: "fixture", id: "selected" })
})
