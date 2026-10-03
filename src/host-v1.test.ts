import { describe, expect, it } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { SessionIdSchema } from "./host-port.ts"
import { createV1Host } from "./host-v1.ts"

const SID = SessionIdSchema.parse("ses_adapter")

describe("createV1Host", () => {
  it("reads the last assistant model and last user text when history contains mixed parts", async () => {
    // Given a real SDK talking to a loopback HTTP fixture.
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        Response.json([
          { info: { role: "assistant", providerID: "old", modelID: "old" }, parts: [] },
          { info: { role: "user" }, parts: [{ type: "text", text: "earlier" }] },
          { info: { role: "assistant", providerID: "provider", modelID: "model" }, parts: [] },
          {
            info: { role: "user" },
            parts: [
              { type: "text", text: "first" },
              { type: "file", url: "file:///ignored" },
              { type: "text", text: "second" },
            ],
          },
        ]),
    })
    try {
      const host = createV1Host(createOpencodeClient({ baseUrl: server.url.href }))
      // When the adapter reads the session.
      const context = await host.readSessionContext(SID)
      // Then it preserves the existing V1 selection policy.
      expect(context).toEqual({
        model: { providerID: "provider", modelID: "model" },
        lastUserText: "first\nsecond",
      })
    } finally {
      server.stop(true)
    }
  })

  it("admits one text prompt with the selected model when invoked", async () => {
    // Given a real SDK and recording HTTP endpoint.
    const requests: { readonly path: string; readonly body: unknown }[] = []
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        requests.push({ path: new URL(request.url).pathname, body: await request.json() })
        return Response.json({})
      },
    })
    try {
      const host = createV1Host(createOpencodeClient({ baseUrl: server.url.href }))
      const model = { providerID: "provider", modelID: "model" }
      // When the report is admitted.
      await host.prompt(SID, { model, text: "fixture-payload" })
      // Then the wire protocol, not rendered report wording, is preserved.
      expect(requests).toEqual([
        {
          path: `/session/${SID}/message`,
          body: {
            model,
            parts: [{ type: "text", text: "fixture-payload" }],
          },
        },
      ])
    } finally {
      server.stop(true)
    }
  })

  it("sends no request when prompt admission is already cancelled", async () => {
    // Given a cancelled watch.
    let requests = 0
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        requests += 1
        return Response.json({})
      },
    })
    try {
      const host = createV1Host(createOpencodeClient({ baseUrl: server.url.href }))
      // When admission receives the cancelled signal.
      await host.prompt(SID, { text: "fixture-payload" }, AbortSignal.abort())
      // Then nothing reaches the SDK endpoint.
      expect(requests).toBe(0)
    } finally {
      server.stop(true)
    }
  })

  it("maps title, toast and diagnostics onto their V1 routes when requested", async () => {
    // Given recording endpoints for the remaining adapter operations.
    const requests: string[] = []
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        requests.push(`${request.method} ${new URL(request.url).pathname}`)
        return Response.json({ title: "fixture-title" })
      },
    })
    try {
      const host = createV1Host(createOpencodeClient({ baseUrl: server.url.href }))
      // When the host boundary is exercised as one adapter scenario.
      const title = await host.getSessionTitle(SID)
      await host.toast?.({ title: "CI Loop", message: "fixture", variant: "info" })
      await host.log("info", "fixture")
      // Then each public operation reaches its unchanged V1 endpoint.
      expect(title).toBe("fixture-title")
      expect(requests).toEqual([`GET /session/${SID}`, "POST /tui/show-toast", "POST /log"])
    } finally {
      server.stop(true)
    }
  })
})
