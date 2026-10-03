import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { closeSync, openSync } from "node:fs"
import net from "node:net"
import { setTimeout as delay } from "node:timers/promises"

export const progress = (label) => console.log(`[e2e ${new Date().toISOString()}] ${label}`)

/** Poll external processes with a deadline, not a fixed startup sleep. */
export async function until(label, check, signal) {
  progress(`Waiting: ${label}`)
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(90_000)])
  let nextProgress = Date.now() + 10_000
  while (true) {
    deadline.throwIfAborted()
    const value = await check(deadline)
    if (value) return value
    if (Date.now() >= nextProgress) {
      progress(`Still waiting: ${label}`)
      nextProgress = Date.now() + 10_000
    }
    await delay(250, undefined, { signal: deadline })
  }
}

export async function freePort() {
  const listener = net.createServer()
  listener.listen(0, "127.0.0.1")
  await once(listener, "listening")
  const address = listener.address()
  assert(address && typeof address !== "string")
  await new Promise((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())))
  return address.port
}

/** Own process groups, including subprocesses that outlive their immediate parent. */
export class Processes {
  children = []

  start(command, args, options) {
    const fd = openSync(options.log, "a", 0o600)
    try {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        detached: true,
        stdio: ["ignore", fd, fd],
      })
      const closed = new Promise((resolve) => {
        child.once("error", (error) => resolve({ error }))
        child.once("close", (code, signal) => resolve({ code, signal }))
      })
      this.children.push({ child, closed })
      return { child, closed }
    } finally {
      closeSync(fd)
    }
  }

  async close() {
    const send = (pid, signal) => {
      if (!pid) return
      try {
        process.kill(-pid, signal)
      } catch (error) {
        if (error.code !== "ESRCH") throw error
      }
    }
    for (const { child } of this.children.toReversed()) send(child.pid, "SIGTERM")
    await Promise.race([Promise.all(this.children.map(({ closed }) => closed)), delay(3000)])
    for (const { child } of this.children.toReversed()) send(child.pid, "SIGKILL")
    await Promise.all(this.children.map(({ closed }) => closed))
  }
}
