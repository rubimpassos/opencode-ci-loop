import assert from "node:assert/strict"

/** Test transport: bounded native fetch, no retries masking a failed mutation. */
export function httpClient(base, context) {
  return async (path, options = {}) => {
    const response = await fetch(`${base}${path}`, {
      method: options.method ?? "GET",
      redirect: "error",
      signal: AbortSignal.any([context.signal, AbortSignal.timeout(15_000)]),
      headers: {
        "content-type": "application/json",
        ...context.headers(),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    })
    context.onCookie?.(response.headers.get("set-cookie"))
    const text = await response.text()
    const status = response.status
    context.record?.({
      method: options.method ?? "GET",
      url: `${base}${path}`,
      body: options.body,
      status,
      response: text,
    })
    assert.equal(status, options.status ?? 200, `${options.method ?? "GET"} ${path}: ${status} ${text}`)
    return text ? JSON.parse(text) : null
  }
}

export async function firstSseFrame(url, signal) {
  const controller = new AbortController()
  const combined = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(15_000)])
  const response = await fetch(url, { signal: combined, redirect: "error" })
  assert.equal(response.status, 200)
  assert.match(response.headers.get("content-type"), /^text\/event-stream/)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ""
  try {
    while (true) {
      const { value, done } = await reader.read()
      assert(!done, "SSE ended before a data frame")
      text += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n")
      const frame = text
        .split("\n\n")
        .slice(0, -1)
        .find((item) => /^data: /m.test(item))
      if (frame)
        return JSON.parse(
          frame
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6))
            .join("\n"),
        )
    }
  } finally {
    try {
      await reader.cancel()
    } finally {
      controller.abort()
    }
  }
}
