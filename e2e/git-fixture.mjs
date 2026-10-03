// Real temporary Git repo whose origin is GitHub-shaped (so A's remote parser sees e2e/fixture) while
// every push/fetch goes to a local bare repo — the Git transport never leaves disk.
//
// Why not `url.<bare>.insteadOf`: git expands insteadOf/pushInsteadOf in the push output, so
// a push would print `To /tmp/.../remote.git` and A's push parser (src/resolve.ts)
// would ignore the push. Instead the remote keeps its https URL and is routed through a repo-scoped
// remote helper: `remote.origin.vcs=e2e` makes git run `git remote-e2e`, which a repo-local alias maps to
// `git remote-ext ... "git %s <bare>"`. Output then reads `To https://github.com/e2e/fixture.git`.
// `protocol.allow=never` blocks every other transport (https included), so a stray
// `git ls-remote https://github.com/...` fails locally instead of touching the network.
// Hooks, signing and the user's global/system config are disabled.

import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { FIXTURE_BRANCH, FIXTURE_REPO_URL } from "./fixtures.mjs"

export const FIXTURE_ORIGIN = `${FIXTURE_REPO_URL}.git`

/**
 * Env that isolates git from the user's config. Merge into any child env that runs git in the fixture
 * (OpenCode's shell tool included) so a global hook/signing setup can never leak in.
 * @param {string} scratch
 */
export function gitEnv(scratch) {
  return {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(scratch, "gitconfig-global"),
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "E2E Fixture",
    GIT_AUTHOR_EMAIL: "e2e@fixture.invalid",
    GIT_COMMITTER_NAME: "E2E Fixture",
    GIT_COMMITTER_EMAIL: "e2e@fixture.invalid",
  }
}

/**
 * @param {string} cwd
 * @param {readonly string[]} args
 * @param {Record<string, string>} env
 */
function git(cwd, args, env) {
  return execFileSync("git", args, { cwd, env: { ...process.env, ...env }, encoding: "utf8" }).trim()
}

/**
 * Creates `<scratch>/<name>/{repo,remote.git}` with one commit on FIXTURE_BRANCH.
 * @param {{ scratch: string, name?: string }} input
 * @returns {{ repo: string, bare: string, env: Record<string, string>, commit: (message: string) => string }}
 */
export function createGitFixture({ scratch, name = "fixture" }) {
  const root = mkdtempSync(join(scratch, `${name}-`))
  const repo = join(root, "repo")
  const bare = join(root, "remote.git")
  const env = gitEnv(root)
  writeFileSync(env.GIT_CONFIG_GLOBAL, "")
  mkdirSync(repo)
  git(root, ["init", "--quiet", "--bare", bare], env)
  git(repo, ["init", "--quiet", "--initial-branch", FIXTURE_BRANCH], env)
  const scoped = [
    ["user.name", "E2E Fixture"],
    ["user.email", "e2e@fixture.invalid"],
    ["core.hooksPath", "/dev/null"],
    ["commit.gpgSign", "false"],
    ["tag.gpgSign", "false"],
    ["push.gpgSign", "false"],
    ["protocol.allow", "never"],
    ["protocol.e2e.allow", "always"],
    // `#` swallows the trailing argv git appends to `!` aliases; the helper reads its URL from "$1".
    ["alias.remote-e2e", `!git remote-ext "$1" "git %s ${bare}" #`],
  ]
  for (const [key, value] of scoped) git(repo, ["config", "--local", key, value], env)
  git(repo, ["remote", "add", "origin", FIXTURE_ORIGIN], env)
  git(repo, ["config", "--local", "remote.origin.vcs", "e2e"], env)
  const commit = (message) => {
    writeFileSync(join(repo, "README.md"), `${message}\n`)
    git(repo, ["add", "README.md"], env)
    git(repo, ["commit", "--quiet", "--no-verify", "-m", message], env)
    return git(repo, ["rev-parse", "HEAD"], env)
  }
  commit("chore: e2e fixture initial commit")
  return { repo, bare, env, commit }
}
