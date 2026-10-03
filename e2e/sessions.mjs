import assert from "node:assert/strict"
import { z } from "zod"
import { until } from "./lifecycle.mjs"

const Id = z.string().min(1)
const Part = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("reasoning"), text: z.string() }),
  z.object({
    type: z.literal("tool"),
    name: z.string(),
    state: z.object({ status: z.enum(["streaming", "running", "completed", "error"]) }),
  }),
])
const Messages = z.object({
  data: z.array(
    z.discriminatedUnion("type", [
      z.object({ id: Id, type: z.literal("user"), text: z.string() }),
      z.object({
        id: Id,
        type: z.enum([
          "agent-switched",
          "model-switched",
          "location-switched",
          "synthetic",
          "system",
          "skill",
          "shell",
          "compaction",
          "idle",
        ]),
      }),
      z.object({
        id: Id,
        type: z.literal("assistant"),
        content: z.array(Part),
        finish: z.string().optional(),
      }),
    ]),
  ),
})

export function sessionClient(stack) {
  const createSession = async (title) => {
    const response = await stack.code("/api/session", {
      method: "POST",
      body: {
        title,
        location: { directory: stack.fixture.repo },
        model: { providerID: "fake", id: "fake-a" },
      },
    })
    return z.object({ data: z.object({ id: Id }) }).parse(response).data.id
  }
  const messages = async (id) => {
    const result = await stack.code(`/api/session/${id}/message?limit=100&order=asc`)
    const parsed = Messages.parse(result)
    return parsed.data.flatMap((message) => {
      switch (message.type) {
        case "agent-switched":
        case "model-switched":
        case "location-switched":
        case "synthetic":
        case "system":
        case "skill":
        case "shell":
        case "compaction":
        case "idle":
          return []
        case "user":
          return { id: message.id, role: "user", text: message.text, tools: [], complete: true }
        case "assistant":
          return {
            id: message.id,
            role: "assistant",
            complete: Boolean(message.finish),
            text: message.content
              .flatMap((part) => {
                switch (part.type) {
                  case "text":
                    return [part.text]
                  case "tool":
                  case "reasoning":
                    return []
                  default:
                    return assert.fail(`Unexpected part: ${part.type}`)
                }
              })
              .join("\n"),
            tools: message.content.flatMap((part) => {
              switch (part.type) {
                case "tool":
                  return [part.name]
                case "text":
                case "reasoning":
                  return []
                default:
                  return assert.fail(`Unexpected part: ${part.type}`)
              }
            }),
          }
        default:
          return assert.fail(`Unexpected message: ${message.type}`)
      }
    })
  }
  const prompt = async (id, text) => {
    const before = new Set((await messages(id)).map((message) => message.id))
    await stack.code(`/api/session/${id}/prompt`, { method: "POST", body: { text } })
    await until(
      `assistant completes ${text} in ${id}`,
      async () =>
        (await messages(id)).some(
          (message) =>
            !before.has(message.id) &&
            message.role === "assistant" &&
            message.complete &&
            message.text.length > 0,
        ),
      stack.signal,
    )
  }
  return { createSession, messages, prompt }
}
