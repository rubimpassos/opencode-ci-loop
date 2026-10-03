import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { z } from "zod"
import { configure, writeConfig } from "./config.mjs"
import { httpClient } from "./http.mjs"
import { freePort, progress, until } from "./lifecycle.mjs"
import { sessionClient } from "./sessions.mjs"

const ProviderRequests = z.array(
  z.object({ isReport: z.boolean(), lastText: z.string(), model: z.string() }).passthrough(),
)

/** The caller owns scratch/process cleanup even when startup fails halfway through. */
export async function startStack(options) {
  const { scratch, root, artifacts, processes, signal } = options
  const packageRoot = options.packageRoot ?? root
  const config = configure(scratch, root)
  const { env, dirs, fixture } = config
  const record = (entry) =>
    appendFileSync(join(dirs.logs, "http.jsonl"), `${JSON.stringify(entry)}\n`, { mode: 0o600 })
  for (const secret of [config.password, config.serverPassword]) artifacts.secrets.add(secret)
  const cli = resolve(process.env.OPENCHAMBER_CLI || join(root, "../openchamber/packages/web/bin/cli.js"))
  assert(existsSync(cli), `Missing OpenChamber CLI: ${cli}`)
  assert(existsSync(join(dirname(cli), "../dist/index.html")), "Build B SDK and web first")
  const opencodeVersion = execFileSync(env.OPENCODE_BINARY, ["--version"], {
    env,
    encoding: "utf8",
    timeout: 15_000,
  }).trim()
  const version = /v?(\d+)\.(\d+)\.(\d+)/.exec(opencodeVersion)
  assert(
    version && Number(version[1]) === 2 && (Number(version[2]) > 0 || Number(version[3]) >= 20),
    `OpenCode >=2.0.20 in 2.x required: ${opencodeVersion}`,
  )
  const versions = {
    node: process.version,
    opencode: opencodeVersion,
    openchamber: JSON.parse(readFileSync(join(dirname(cli), "../package.json"), "utf8")).version,
    fork: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dirname(cli),
      env,
      encoding: "utf8",
      timeout: 5000,
    }).trim(),
  }
  artifacts.json("stack/versions.json", versions)
  const launch = (command, args, name) =>
    processes.start(command, args, { cwd: fixture.repo, env, log: join(dirs.logs, name) })
  launch(process.execPath, [join(root, "e2e/fake-provider.mjs")], "provider-process.log")
  const providerPort = await until(
    "fake provider port",
    () => /FAKE_PROVIDER_PORT=(\d+)/.exec(readFileSync(join(dirs.logs, "provider-process.log"), "utf8"))?.[1],
    signal,
  )
  const ciPort = await freePort()
  assert.notEqual(ciPort, 4517)
  env.OPENCHAMBER_CI_LOOP_PORT = String(ciPort)
  writeConfig(config, packageRoot, providerPort)
  const codePort = await freePort()
  const codeUrl = `http://127.0.0.1:${codePort}`
  const ciUrl = `http://127.0.0.1:${ciPort}`
  const authorization = `Basic ${Buffer.from(`opencode:${config.serverPassword}`).toString("base64")}`
  artifacts.secrets.add(authorization)
  // Explicit external mode: the harness owns the entire OpenCode process group. B's managed
  // process is detached separately and rotates its password, complicating reliable failure cleanup.
  launch(
    env.OPENCODE_BINARY,
    ["serve", "--hostname", "127.0.0.1", "--port", String(codePort)],
    "opencode.log",
  )
  await until(
    "OpenCode announces its owned listener",
    () => readFileSync(join(dirs.logs, "opencode.log"), "utf8").includes(`server listening on ${codeUrl}`),
    signal,
  )
  const code = httpClient(codeUrl, { signal, record, headers: () => ({ authorization }) })
  await waitForListener(`${codeUrl}/api/info`, { authorization }, signal)
  const info = await code("/api/info")
  artifacts.json("stack/runtime-info.json", info)
  const ocPort = await freePort()
  const ocUrl = `http://127.0.0.1:${ocPort}`
  env.OPENCODE_HOST = codeUrl
  env.OPENCODE_SKIP_START = "true"
  launch(
    process.execPath,
    [cli, "serve", "--foreground", "--port", String(ocPort), "--host", "127.0.0.1"],
    "openchamber.log",
  )
  await until(
    "OpenChamber announces its owned listener",
    () =>
      readFileSync(join(dirs.logs, "openchamber.log"), "utf8").includes(
        `OpenChamber server listening on 127.0.0.1:${ocPort}`,
      ),
    signal,
  )
  await waitForListener(`${ocUrl}/auth/session`, {}, signal)
  let cookie = ""
  const api = httpClient(ocUrl, {
    signal,
    record,
    headers: () => (cookie ? { cookie } : {}),
    onCookie: (header) => {
      if (!header) return
      cookie = header.split(";")[0]
      artifacts.secrets.add(cookie)
      artifacts.secrets.add(cookie.slice(cookie.indexOf("=") + 1))
    },
  })
  await api("/auth/session", { method: "POST", body: { password: config.password } })
  assert(cookie, "Login did not set a cookie")
  const cookieJar = join(scratch, "cookies.txt")
  const separator = cookie.indexOf("=")
  writeFileSync(
    cookieJar,
    `# Netscape HTTP Cookie File\n127.0.0.1\tFALSE\t/\tFALSE\t0\t${cookie.slice(0, separator)}\t${cookie.slice(separator + 1)}\n`,
    { mode: 0o600 },
  )
  await api("/api/guests", { method: "POST", body: { path: packageRoot }, status: 201 })
  const grant = (granted) => api("/api/guests/ci-loop/capabilities", { method: "PUT", body: { granted } })
  await grant(["loopback"])
  const guestToken = async () => {
    const result = z
      .object({ token: z.string().min(1) })
      .parse(await api("/auth/url-token", { method: "POST", body: { scope: "guest:ci-loop" } }))
    artifacts.secrets.add(result.token)
    return result.token
  }
  const stack = {
    ...config,
    signal,
    code,
    api,
    grant,
    guestToken,
    versions,
    cookieJar,
    ocUrl,
    ciUrl,
    codeUrl,
    ci: httpClient(ciUrl, { signal, record, headers: () => ({}) }),
    providerRequests: () =>
      existsSync(env.FAKE_PROVIDER_LOG)
        ? ProviderRequests.parse(
            readFileSync(env.FAKE_PROVIDER_LOG, "utf8")
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line)),
          )
        : [],
  }
  progress(`Stack ready: OpenChamber ${ocUrl}, OpenCode ${codeUrl}, CI ${ciUrl}; package ${packageRoot}`)
  return { ...stack, ...sessionClient(stack) }
}

async function waitForListener(url, headers, signal) {
  await until(
    `listener ${url}`,
    async (deadline) => {
      try {
        const response = await fetch(url, {
          headers,
          signal: AbortSignal.any([deadline, AbortSignal.timeout(2000)]),
        })
        await response.body?.cancel()
        return response.status === 200 || response.status === 401
      } catch (error) {
        if (error instanceof TypeError && ["ECONNREFUSED", "ECONNRESET"].includes(error.cause?.code))
          return false
        throw error
      }
    },
    signal,
  )
}
