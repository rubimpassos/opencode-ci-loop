import { describe, expect, it } from "bun:test"
import type { Exec, ExecResult } from "./gh.ts"
import { parsePushOutput, resolvePushTargets } from "./resolve.ts"
import type { CommitSha } from "./types.ts"

const SESSION_DIR = "/repo"
const FULL_SHA = "2222222222222222222222222222222222222222" as CommitSha

function scriptedExec(script: Record<string, string | ExecResult>): Exec {
  return async (argv, cwd) => {
    const command = argv.join(" ")
    const entries = Object.entries(script)
    const match =
      entries.find(([pattern]) => `${cwd} :: ${command}`.startsWith(pattern)) ??
      entries.find(([pattern]) => command.startsWith(pattern))
    const response = match?.[1]
    if (response === undefined) {
      return { exitCode: 1, stdout: "", stderr: `no script for: ${cwd} :: ${command}` }
    }
    return typeof response === "string" ? { exitCode: 0, stdout: response, stderr: "" } : response
  }
}

const SESSION_GIT = {
  "/repo :: git rev-parse --show-toplevel": "/repo\n",
  "/repo :: git rev-parse --absolute-git-dir": "/repo/.git\n",
  "/repo :: git rev-parse --path-format=absolute --git-common-dir": "/repo/.git\n",
}

function pushOutput(refspec = "local -> remote"): string {
  return `To git@github.com:owner/project.git\n   1111111..2222222  ${refspec}\n`
}

describe("parsePushOutput", () => {
  it("parses multiple branch updates and strips ANSI while ignoring tags and deletes", () => {
    const output = [
      "\u001b[32mTo https://ghe.example.com/acme/widget.git\u001b[0m",
      " * [new branch]      HEAD -> feature/head",
      "   1111111..2222222  local -> remote",
      " + aaaaaaa...bbbbbbb old -> forced (forced update)",
      " * [new tag]         v1.0.0 -> v1.0.0",
      " - [deleted]         obsolete -> obsolete",
      "Everything up-to-date",
    ].join("\n")

    const parsed = parsePushOutput(output)

    expect(parsed).toEqual([
      {
        remoteUrl: "https://ghe.example.com/acme/widget.git",
        srcRef: "HEAD",
        dstBranch: "feature/head",
        newShaPrefix: null,
      },
      {
        remoteUrl: "https://ghe.example.com/acme/widget.git",
        srcRef: "local",
        dstBranch: "remote",
        newShaPrefix: "2222222",
      },
      {
        remoteUrl: "https://ghe.example.com/acme/widget.git",
        srcRef: "old",
        dstBranch: "forced",
        newShaPrefix: "bbbbbbb",
      },
    ])
  })

  it("returns no updates for tag-only and up-to-date pushes", () => {
    expect(
      parsePushOutput("To git@github.com:o/r.git\n * [new tag] v1 -> v1\nEverything up-to-date\n"),
    ).toEqual([])
  })
})

describe("resolvePushTargets", () => {
  it("uses destination branch identity and resolves HEAD from a valid session cwd", async () => {
    const targets = await resolvePushTargets(
      "To git@github.com:owner/project.git\n * [new branch] HEAD -> feature\n",
      "git push origin HEAD:refs/heads/feature",
      {},
      {
        exec: scriptedExec({
          ...SESSION_GIT,
          "/repo :: git rev-parse --verify HEAD^{commit}": `${FULL_SHA}\n`,
        }),
        sessionDir: SESSION_DIR,
      },
    )

    expect(targets).toEqual([
      {
        sha: FULL_SHA,
        branch: "feature",
        repo: "github.com/owner/project",
        repoUrl: "git@github.com:owner/project",
        directory: "/repo",
        sourceKind: "session",
      },
    ])
  })

  it("classifies a linked worktree supplied by raw workdir", async () => {
    const targets = await resolvePushTargets(
      pushOutput(),
      "git push",
      { workdir: "/repo-feature" },
      {
        exec: scriptedExec({
          ...SESSION_GIT,
          "/repo-feature :: git rev-parse --show-toplevel": "/repo-feature\n",
          "/repo-feature :: git rev-parse --absolute-git-dir": "/repo/.git/worktrees/repo-feature\n",
          "/repo-feature :: git rev-parse --path-format=absolute --git-common-dir": "/repo/.git\n",
          "/repo-feature :: git rev-parse --verify local^{commit}": `${FULL_SHA}\n`,
        }),
        sessionDir: SESSION_DIR,
      },
    )

    expect(targets[0]?.sourceKind).toBe("linked-worktree")
    expect(targets[0]?.directory).toBe("/repo-feature")
    expect(targets[0]?.branch).toBe("remote")
  })

  it("classifies an external repo supplied by raw cwd", async () => {
    const targets = await resolvePushTargets(
      pushOutput(),
      "git push",
      { cwd: "/external" },
      {
        exec: scriptedExec({
          ...SESSION_GIT,
          "/external :: git rev-parse --show-toplevel": "/external\n",
          "/external :: git rev-parse --absolute-git-dir": "/external/.git\n",
          "/external :: git rev-parse --path-format=absolute --git-common-dir": "/external/.git\n",
          "/external :: git rev-parse --verify local^{commit}": `${FULL_SHA}\n`,
        }),
        sessionDir: SESSION_DIR,
      },
    )

    expect(targets[0]?.sourceKind).toBe("external-repo")
    expect(targets[0]?.directory).toBe("/external")
  })

  it.each([
    ["git -C ../repo-feature push origin local:remote", "/repo-feature"],
    ["cd ../repo-feature && git push origin local:remote", "/repo-feature"],
  ])("extracts a simple command cwd from %s", async (command, expectedDirectory) => {
    const targets = await resolvePushTargets(
      pushOutput(),
      command,
      {},
      {
        exec: scriptedExec({
          ...SESSION_GIT,
          "/repo-feature :: git rev-parse --show-toplevel": "/repo-feature\n",
          "/repo-feature :: git rev-parse --absolute-git-dir": "/repo/.git/worktrees/repo-feature\n",
          "/repo-feature :: git rev-parse --path-format=absolute --git-common-dir": "/repo/.git\n",
          "/repo-feature :: git rev-parse --verify local^{commit}": `${FULL_SHA}\n`,
        }),
        sessionDir: SESSION_DIR,
      },
    )

    expect(targets[0]?.directory).toBe(expectedDirectory)
  })

  it("falls back to ls-remote and downgrades source metadata when the cwd SHA mismatches", async () => {
    const targets = await resolvePushTargets(
      pushOutput(),
      "git push",
      {},
      {
        exec: scriptedExec({
          ...SESSION_GIT,
          "/repo :: git rev-parse --verify local^{commit}": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
          "git ls-remote git@github.com:owner/project.git refs/heads/remote": `${FULL_SHA}\trefs/heads/remote\n`,
        }),
        sessionDir: SESSION_DIR,
      },
    )

    expect(targets[0]?.sha).toBe(FULL_SHA)
    expect(targets[0]?.sourceKind).toBe("unknown")
    expect(targets[0]?.directory).toBeNull()
  })

  it("uses ls-remote when cwd validation fails and skips an unresolvable target", async () => {
    const resolvable = await resolvePushTargets(
      pushOutput(),
      "git push",
      { cwd: "/missing" },
      {
        exec: scriptedExec({
          ...SESSION_GIT,
          "git ls-remote git@github.com:owner/project.git refs/heads/remote": `${FULL_SHA}\trefs/heads/remote\n`,
        }),
        sessionDir: SESSION_DIR,
      },
    )
    const skipped = await resolvePushTargets(
      pushOutput(),
      "git push",
      { cwd: "/missing" },
      {
        exec: scriptedExec(SESSION_GIT),
        sessionDir: SESSION_DIR,
      },
    )

    expect(resolvable[0]?.sourceKind).toBe("unknown")
    expect(resolvable[0]?.directory).toBeNull()
    expect(skipped).toEqual([])
  })

  it("skips local and otherwise unparseable remote URLs", async () => {
    const targets = await resolvePushTargets(
      "To /tmp/bare.git\n * [new branch] HEAD -> feature\n",
      "git push",
      {},
      { exec: scriptedExec(SESSION_GIT), sessionDir: SESSION_DIR },
    )

    expect(targets).toEqual([])
  })
})
