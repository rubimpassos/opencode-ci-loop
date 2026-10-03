#!/usr/bin/env node
// Scripted OpenAI-compatible provider (adapted from openchamber-omo/e2e/fake-provider.mjs). It answers
// POST /v1/chat/completions (streamed SSE) and GET /v1/models; the agent's behaviour is decided by
// trigger tokens in the conversation, not by a model:
//
// - last message is a `[ci-loop]` report      → plain text "E2E-ACK ..." (never a tool call, never pushes)
// - last message is a tool result             → plain text "E2E-DONE" (ends the turn; no loops)
// - user prompt contains E2E-PUSH             → one shell tool call running FAKE_PUSH_COMMAND
// - user prompt contains E2E-WATCH-<action>   → one ci_watch tool call {action} (status|enable|disable)
// - user prompt contains E2E-DELAY            → answers after FAKE_PROVIDER_SLOW_MS (session-switch races)
// - user prompt contains E2E-REFUSE           → HTTP 500 error body (error-state fixture)
// - anything else                             → plain text "E2E"
//
// Env contract:
//   FAKE_PROVIDER_PORT     listen port on 127.0.0.1 (default 0 = ephemeral; printed as FAKE_PROVIDER_PORT=<n>)
//   FAKE_PROVIDER_LOG      JSONL file; one line per request {at, path, model, lastRole, lastText, isReport, tools, reply}
//   FAKE_PROVIDER_DELAY_MS base latency per completion (default 0)
//   FAKE_PROVIDER_SLOW_MS  latency for E2E-DELAY prompts (default 8000)
//   FAKE_SHELL_TOOL        shell tool id to call (default "shell": OpenCode V2 2.0.22 renamed `bash` → `shell`;
//                          if the request's tool list lacks it but offers `bash`, `bash` is used instead)
//   FAKE_PUSH_COMMAND      command for E2E-PUSH (default PUSH_COMMAND, the plain push an agent runs; A's
//                          push parser reads git's human `old..new  src -> dst` lines, not `--porcelain`)

import { appendFileSync } from "node:fs"
import http from "node:http"
import { pathToFileURL } from "node:url"

export const PUSH_COMMAND = "git push origin HEAD:refs/heads/feature/e2e"
const WATCH_ACTIONS = ["status", "enable", "disable"]

const textOf = (content) => {
  if (typeof content === "string") return content
  if (Array.isArray(content))
    return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n")
  return ""
}

export const isReport = (text) => /^\s*\[ci-loop\]/m.test(text)

/**
 * Pure decision: what to answer for a chat-completions body.
 * @returns {{ kind: "text", content: string } | { kind: "tools", calls: { name: string, arguments: object }[] } | { kind: "error", status: number, message: string }}
 */
export function decide(body, { shellTool = "shell", pushCommand = PUSH_COMMAND } = {}) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const last = messages.at(-1)
  const lastText = textOf(last?.content)
  const tools = Array.isArray(body.tools) ? body.tools.map((tool) => tool?.function?.name) : []
  if (last?.role === "tool") return { kind: "text", content: "E2E-DONE" }
  if (last?.role !== "user") return { kind: "text", content: "E2E" }
  if (isReport(lastText))
    return { kind: "text", content: `E2E-ACK received ci-loop report (${lastText.length} chars)` }
  if (lastText.includes("E2E-REFUSE"))
    return { kind: "error", status: 500, message: "E2E-REFUSE scripted provider failure" }
  if (lastText.includes("E2E-PUSH")) {
    const name = tools.includes(shellTool) || !tools.includes("bash") ? shellTool : "bash"
    return {
      kind: "tools",
      calls: [{ name, arguments: { command: pushCommand, description: "Push the e2e branch" } }],
    }
  }
  const watch = lastText.match(/E2E-WATCH-(\w+)/)?.[1]
  if (watch !== undefined && WATCH_ACTIONS.includes(watch)) {
    return { kind: "tools", calls: [{ name: "ci_watch", arguments: { action: watch } }] }
  }
  return { kind: "text", content: "E2E" }
}

const chunk = (model, delta, finish = null) =>
  `data: ${JSON.stringify({
    id: "chatcmpl-e2e",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`

const usage = (model) =>
  `data: ${JSON.stringify({
    id: "chatcmpl-e2e",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [],
    usage: { prompt_tokens: 1200, completion_tokens: 40, total_tokens: 1240 },
  })}\n\n`

let callSeq = 0

function stream(res, model, reply) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  if (reply.kind === "text") {
    res.write(chunk(model, { role: "assistant", content: reply.content }))
    res.write(chunk(model, {}, "stop"))
  } else {
    res.write(chunk(model, { role: "assistant", content: "" }))
    reply.calls.forEach((call, index) => {
      callSeq += 1
      const fn = { name: call.name, arguments: JSON.stringify(call.arguments) }
      res.write(
        chunk(model, { tool_calls: [{ index, id: `call_e2e_${callSeq}`, type: "function", function: fn }] }),
      )
    })
    res.write(chunk(model, {}, "tool_calls"))
  }
  res.write(usage(model))
  res.end("data: [DONE]\n\n")
}

/**
 * @param {{ port?: number, logFile?: string, delayMs?: number, slowMs?: number, shellTool?: string, pushCommand?: string }} options
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
export function startFakeProvider({
  port = 0,
  logFile = "",
  delayMs = 0,
  slowMs = 8000,
  shellTool = "shell",
  pushCommand = PUSH_COMMAND,
} = {}) {
  const server = http.createServer((req, res) => {
    let raw = ""
    req.on("data", (part) => {
      raw += part
    })
    req.on("end", () => {
      if (req.method === "GET" && req.url?.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ object: "list", data: [{ id: "fake-a", object: "model" }] }))
        return
      }
      if (req.method !== "POST" || !req.url?.includes("/chat/completions")) {
        res.writeHead(404, { "content-type": "application/json" })
        res.end(
          JSON.stringify({ error: { message: `fake provider: ${req.method} ${req.url} not scripted` } }),
        )
        return
      }
      let body = {}
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch {
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: { message: "fake provider: malformed JSON body" } }))
        return
      }
      const reply = decide(body, { shellTool, pushCommand })
      const last = Array.isArray(body.messages) ? body.messages.at(-1) : undefined
      const lastText = textOf(last?.content)
      if (logFile) {
        const tools = (body.tools ?? []).map((tool) => tool?.function?.name)
        const entry = {
          at: Date.now(),
          path: req.url,
          model: body.model,
          lastRole: last?.role,
          lastText,
          isReport: isReport(lastText),
          tools,
          reply,
        }
        appendFileSync(logFile, `${JSON.stringify(entry)}\n`)
      }
      const wait = lastText.includes("E2E-DELAY") ? slowMs : delayMs
      setTimeout(() => {
        if (reply.kind === "error") {
          res.writeHead(reply.status, { "content-type": "application/json" })
          res.end(JSON.stringify({ error: { message: reply.message, type: "server_error" } }))
          return
        }
        stream(res, String(body.model ?? "fake-a"), reply)
      }, wait)
    })
  })
  return new Promise((resolvePromise) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address()
      resolvePromise({
        port: typeof address === "object" && address !== null ? address.port : port,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections()
            server.close(() => done())
          }),
      })
    })
  })
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { port } = await startFakeProvider({
    port: Number(process.env.FAKE_PROVIDER_PORT ?? 0),
    logFile: process.env.FAKE_PROVIDER_LOG ?? "",
    delayMs: Number(process.env.FAKE_PROVIDER_DELAY_MS ?? 0),
    slowMs: Number(process.env.FAKE_PROVIDER_SLOW_MS ?? 8000),
    shellTool: process.env.FAKE_SHELL_TOOL || "shell",
    pushCommand: process.env.FAKE_PUSH_COMMAND || PUSH_COMMAND,
  })
  process.stdout.write(`FAKE_PROVIDER_PORT=${port}\n`)
}
