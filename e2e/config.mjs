import { randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { createGitFixture } from "./git-fixture.mjs"

export function configure(scratch, root) {
  const dirs = Object.fromEntries(
    ["home", "data", "cache", "state", "config", "oc", "logs", "bin", "runtime"].map((name) => {
      const dir = join(scratch, name)
      mkdirSync(dir, { mode: 0o700 })
      return [name, dir]
    }),
  )
  const fixture = createGitFixture({ scratch })
  const password = randomBytes(24).toString("base64url")
  const serverPassword = randomBytes(24).toString("base64url")
  const opencodeBinary = process.env.OPENCODE_BINARY || "/home/rubimpassos/.opencode/bin/opencode"
  // An explicit runtime in the shebang; never fall through to the user's real gh.
  const fakeGh = readFileSync(join(root, "e2e/fake-gh.mjs"), "utf8").replace(
    /^#![^\n]+/,
    `#!${process.execPath}`,
  )
  writeFileSync(join(dirs.bin, "gh"), fakeGh, { mode: 0o700 })
  const env = {
    PATH: `${dirs.bin}:${dirname(opencodeBinary)}:${dirname(process.execPath)}:/home/rubimpassos/.bun/bin:/usr/local/bin:/usr/bin:/bin`,
    HOME: dirs.home,
    XDG_CONFIG_HOME: dirs.config,
    XDG_DATA_HOME: dirs.data,
    XDG_CACHE_HOME: dirs.cache,
    XDG_STATE_HOME: dirs.state,
    XDG_RUNTIME_DIR: dirs.runtime,
    TMPDIR: scratch,
    PWD: fixture.repo,
    SHELL: "/bin/sh",
    LANG: "C.UTF-8",
    GIT_MASTER: "1",
    ...fixture.env,
    OPENCODE_CONFIG: join(dirs.config, "opencode.json"),
    OPENCODE_CONFIG_DIR: dirs.config,
    OPENCHAMBER_DATA_DIR: dirs.oc,
    OPENCHAMBER_UI_PASSWORD: password,
    OPENCODE_SERVER_PASSWORD: serverPassword,
    OPENCODE_PASSWORD: serverPassword,
    OPENCODE_BINARY: opencodeBinary,
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCHAMBER_RELAY_HOST: "off",
    FAKE_API_KEY: "e2e-dummy",
    FAKE_GH_STATE: join(scratch, "gh-state.json"),
    FAKE_GH_LOG: join(dirs.logs, "fake-gh.jsonl"),
    FAKE_PROVIDER_PORT: "0",
    FAKE_PROVIDER_LOG: join(dirs.logs, "fake-provider.jsonl"),
  }
  const projectId = `path_${Buffer.from(fixture.repo).toString("base64url")}`
  writeFileSync(
    join(dirs.oc, "settings.json"),
    JSON.stringify({
      projects: [
        {
          id: projectId,
          path: fixture.repo,
          label: "CI Loop E2E",
          addedAt: Date.now(),
          lastOpenedAt: Date.now(),
        },
      ],
      activeProjectId: projectId,
    }),
  )
  return { dirs, fixture, password, serverPassword, env }
}

export function writeConfig(stack, root, providerPort) {
  writeFileSync(
    stack.env.OPENCODE_CONFIG,
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        model: "fake/fake-a",
        update: "disable",
        shell: "/bin/sh",
        plugins: [
          {
            package: join(root, "v2"),
            options: {
              autoWatch: true,
              initialDelayMs: 0,
              pollIntervalMs: 1000,
              language: "en",
              dashboard: { host: "127.0.0.1", port: Number(stack.env.OPENCHAMBER_CI_LOOP_PORT) },
              review: { enabled: true, pollIntervalMs: 5000 },
            },
          },
        ],
        providers: {
          fake: {
            name: "E2E scripted provider",
            env: ["FAKE_API_KEY"],
            package: "@opencode/ai/providers/openai-compatible",
            settings: { baseURL: `http://127.0.0.1:${providerPort}/v1` },
            models: {
              "fake-a": { name: "E2E", capabilities: { tools: true, input: ["text"], output: ["text"] } },
            },
          },
        },
        permissions: [{ action: "*", resource: "*", effect: "allow" }],
      },
      null,
      2,
    ),
    { mode: 0o600 },
  )
}
