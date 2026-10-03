import { expect, it } from "bun:test"
import { Tool } from "@opencode/schema/tool"
import { z } from "zod"
import { setupV2 } from "./plugin-v2.ts"
import { SID, v2Fixture } from "./v2-fixture.test.ts"
import { pushFixture } from "./v2-push-fixture.test.ts"

it.each(["enable", "disable", "status"] as const)(
  "registers and executes ci_watch when action is %s",
  async (action) => {
    // Given the registered V2 tool and the opposite initial enabled setting.
    using fixture = v2Fixture()
    const cleanup = await setupV2({
      ...fixture.ctx,
      options: {
        ...fixture.ctx.options,
        autoWatch: action === "disable",
      },
    })
    try {
      // When the host invokes the registered executor.
      const output = await fixture.execute({ action })
      // Then the real dashboard reflects the action in the session's directory, not the plugin's.
      const response = await fetch(`http://127.0.0.1:${fixture.port}/sessions/${SID}`)
      expect(await response.json()).toMatchObject({
        sessionID: SID,
        directory: fixture.directory,
        enabled: action !== "disable" && action !== "status",
      })
      expect(typeof output.content).toBe("string")
      expect(fixture.tools.get("ci_watch")?.input).toMatchObject({
        type: "object",
        required: ["action"],
        additionalProperties: false,
        properties: { action: { enum: ["enable", "disable", "status"] } },
      })
    } finally {
      await cleanup()
    }
  },
)

it.each([{}, { action: "unknown" }, { action: "enable", extra: true }, null])(
  "rejects input before changing state when ci_watch receives %j",
  async (input) => {
    // Given a freshly registered tool.
    using fixture = v2Fixture()
    const cleanup = await setupV2(fixture.ctx)
    try {
      // When input bypasses the model's schema and reaches the execution boundary.
      await fixture.execute(input).then(
        () => {
          throw new TypeError("Expected invalid input to reject")
        },
        (error: unknown) => expect(error).toBeInstanceOf(z.ZodError),
      )
      // Then invalid input creates no session state.
      const response = await fetch(`http://127.0.0.1:${fixture.port}/state`)
      expect(await response.json()).toEqual([])
    } finally {
      await cleanup()
    }
  },
)

it("aborts the subscription and frees the dashboard when disposed", async () => {
  // Given one live plugin lease.
  using fixture = v2Fixture()
  const cleanup = await setupV2(fixture.ctx)
  // When the host unloads the plugin.
  await cleanup()
  // Then the async subscription exits and the same real port can be bound again.
  expect(fixture.aborted).toBe(true)
  const replacement = Bun.serve({ hostname: "127.0.0.1", port: fixture.port, fetch: () => new Response() })
  replacement.stop(true)
})

it("releases its dashboard lease when hook registration fails", async () => {
  // Given a host refusing hook registration.
  using fixture = v2Fixture()
  const failure = new TypeError("registration unavailable")
  const ctx = {
    ...fixture.ctx,
    tool: {
      ...fixture.ctx.tool,
      hook: async () => {
        throw failure
      },
    },
  }
  // When setup fails after acquiring the shared runtime.
  await setupV2(ctx).then(
    () => {
      throw new TypeError("Expected registration to reject")
    },
    (error: unknown) => expect(error).toBe(failure),
  )
  // Then no listener leaks out of the failed setup.
  const replacement = Bun.serve({ hostname: "127.0.0.1", port: fixture.port, fetch: () => new Response() })
  replacement.stop(true)
})

it.each([".", "child"])("resolves the pushed commit when shell workdir is %s", async (workdir) => {
  // Given a real repository distinct from the plugin location (and optionally the session directory).
  using fixture = pushFixture(workdir)
  const cleanup = await setupV2(fixture.ctx)
  try {
    // When the completed shell hook observes Git's human output.
    await fixture.after(fixture.event)
    // Then a real watch uses the commit and source directory that the shell actually pushed.
    const response = await fetch(`http://127.0.0.1:${fixture.port}/state`)
    expect(await response.json()).toMatchObject([
      {
        directory: fixture.directory,
        sessionID: SID,
        watches: [{ sha: fixture.sha, directory: fixture.repository, branch: "feature/e2e" }],
      },
    ])
    expect(fixture.event.result.content).toMatch(/^To https:\/\/github.com\/e2e\/fixture.git/)
    expect(fixture.event.result.content).not.toBe(fixture.text)
  } finally {
    await cleanup()
  }
})

it("preserves structured content when appending a watch notice", async () => {
  // Given a completed result carrying text, a file, metadata and structured output.
  using fixture = pushFixture()
  const original = {
    content: [
      { type: "text", text: fixture.text },
      { type: "file", uri: "file:///fixture", mime: "text/plain" },
    ],
    metadata: { exit: 0 },
    output: { result: "fixture" },
  } as const
  fixture.event.result = original
  const cleanup = await setupV2(fixture.ctx)
  try {
    // When a watch is started through the registered hook.
    await fixture.after(fixture.event)
    // Then only an extra text part is appended; the original result remains untouched.
    expect(fixture.event.result).toMatchObject({
      ...original,
      content: [...original.content, { type: "text", text: expect.any(String) }],
    })
    expect(fixture.event.result).not.toBe(original)
    expect(original.content).toHaveLength(2)
  } finally {
    await cleanup()
  }
})

it.each(["! [rejected]", "fatal:", "error: failed to push"])(
  "starts no watch when a completed shell contains %s",
  async (marker) => {
    // Given valid push output followed by a failure marker in a separate text part.
    using fixture = pushFixture()
    const original = {
      content: [
        { type: "text", text: fixture.text },
        { type: "text", text: marker },
      ],
    } as const
    fixture.event.result = original
    const cleanup = await setupV2(fixture.ctx)
    try {
      // When shell completion reaches the adapter (e.g. git push ...; true).
      await fixture.after(fixture.event)
      // Then Git rejection wins over host completion.
      expect(await (await fetch(`http://127.0.0.1:${fixture.port}/state`)).json()).toEqual([])
      expect(fixture.event.result).toBe(original)
    } finally {
      await cleanup()
    }
  },
)

it("starts no watch when the shell fails", async () => {
  // Given a failed tool invocation.
  using fixture = pushFixture()
  const cleanup = await setupV2(fixture.ctx)
  try {
    // When the error result reaches the registered hook.
    await fixture.after({ ...fixture.event, status: "error", error: new Tool.Error({ message: "exit 1" }) })
    // Then it cannot be treated as a successful push.
    expect(await (await fetch(`http://127.0.0.1:${fixture.port}/state`)).json()).toEqual([])
  } finally {
    await cleanup()
  }
})

it.each(["read", "bash"])("ignores push-looking results when the tool is %s", async (tool) => {
  // Given valid push output attached to a different tool ID.
  using fixture = pushFixture()
  const cleanup = await setupV2(fixture.ctx)
  try {
    // When that tool reaches the shared hook.
    await fixture.after({ ...fixture.event, tool })
    // Then only the pinned host's shell tool can start a watch.
    expect(await (await fetch(`http://127.0.0.1:${fixture.port}/state`)).json()).toEqual([])
  } finally {
    await cleanup()
  }
})

it("rejects malformed workdir instead of watching the session repository", async () => {
  // Given push-looking output but an invalid shell boundary payload.
  using fixture = pushFixture()
  const event = {
    ...fixture.event,
    input: { command: "git push", workdir: 42, description: "invalid directory" },
  }
  const cleanup = await setupV2(fixture.ctx)
  try {
    // When the adapter receives it.
    await fixture.after(event)
    // Then it does not silently substitute a different source repository.
    expect(await (await fetch(`http://127.0.0.1:${fixture.port}/state`)).json()).toEqual([])
  } finally {
    await cleanup()
  }
})
