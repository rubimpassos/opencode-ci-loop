import { execFileSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { type AfterEvent, toolContext, v2Fixture } from "./v2-fixture.test.ts"

/** Real local Git metadata; the long initial delay keeps GitHub entirely out of these adapter tests. */
export function pushFixture(workdir = ".") {
  const fixture = v2Fixture()
  try {
    const repository = join(fixture.directory, workdir)
    mkdirSync(repository, { recursive: true })
    const git = (args: readonly string[]) =>
      execFileSync("git", [...args], {
        cwd: repository,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_MASTER: "1",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_AUTHOR_NAME: "Fixture",
          GIT_AUTHOR_EMAIL: "fixture@example.invalid",
          GIT_COMMITTER_NAME: "Fixture",
          GIT_COMMITTER_EMAIL: "fixture@example.invalid",
        },
      }).trim()
    git(["init", "--quiet", "--initial-branch=feature/e2e"])
    if (workdir !== ".") git(["init", "--quiet", fixture.directory])
    git([
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "--allow-empty",
      "--quiet",
      "-m",
      "fixture",
    ])
    const sha = git(["rev-parse", "HEAD"])
    const text = `To https://github.com/e2e/fixture.git\n   123abcd..${sha.slice(0, 8)}  HEAD -> feature/e2e\n`
    const event: Extract<AfterEvent, { status: "completed" }> = {
      ...toolContext,
      tool: "shell",
      status: "completed",
      input: {
        command: "git push origin HEAD:refs/heads/feature/e2e",
        description: "Push fixture",
        ...(workdir !== "." && { workdir }),
      },
      result: { content: text },
    }
    return { ...fixture, event, text, sha, repository }
  } catch (error) {
    fixture[Symbol.dispose]()
    throw error
  }
}
