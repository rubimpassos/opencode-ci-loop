import { resolve } from "node:path"
import { z } from "zod"
import type { Exec } from "./gh.ts"
import type { CommitSha, PushTarget, WatchSourceKind } from "./types.ts"

export type ParsedPushUpdate = {
  readonly remoteUrl: string
  readonly srcRef: string
  readonly dstBranch: string
  readonly newShaPrefix: string | null
}

type ResolveContext = {
  readonly exec: Exec
  readonly sessionDir: string
}

type RepoLocation = {
  readonly topLevel: string
  readonly gitDir: string
  readonly commonDir: string
}

type Remote = {
  readonly repo: string
  readonly repoUrl: string
}

const RawArgsSchema = z
  .object({
    workdir: z.string().optional(),
    cwd: z.string().optional(),
  })
  .passthrough()
  .catch({})

const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g")
const UPDATE_LINE = /^(?:[*+=-]\s+)?(.+?)\s+(\S+)\s+->\s+(\S+)(?:\s+\(.+\))?$/
const RANGE_NEW_SHA = /\.\.\.?([0-9a-f]{4,40})$/i
const FULL_SHA = /^[0-9a-f]{40}$/i

export function parsePushOutput(text: string): readonly ParsedPushUpdate[] {
  const updates: ParsedPushUpdate[] = []
  let remoteUrl: string | null = null
  for (const rawLine of text.replace(ANSI_ESCAPE, "").split("\n")) {
    const line = rawLine.trim()
    if (line.startsWith("To ")) {
      remoteUrl = line.slice(3).trim()
      continue
    }
    if (remoteUrl === null || line === "Everything up-to-date") continue
    const match = line.match(UPDATE_LINE)
    const summary = match?.[1]
    const srcRef = match?.[2]
    const rawDst = match?.[3]
    if (summary === undefined || srcRef === undefined || rawDst === undefined) continue
    if (summary.includes("[deleted]") || summary.includes("[new tag]")) continue
    if (srcRef.startsWith("refs/tags/") || rawDst.startsWith("refs/tags/")) continue
    if (rawDst.startsWith("refs/") && !rawDst.startsWith("refs/heads/")) continue
    const dstBranch = rawDst.replace(/^refs\/heads\//, "")
    if (dstBranch.length === 0) continue
    updates.push({
      remoteUrl,
      srcRef,
      dstBranch,
      newShaPrefix: summary.match(RANGE_NEW_SHA)?.[1]?.toLowerCase() ?? null,
    })
  }
  return updates
}

export async function resolvePushTargets(
  pushOutput: string,
  command: string,
  rawArgs: unknown,
  context: ResolveContext,
): Promise<readonly PushTarget[]> {
  const updates = parsePushOutput(pushOutput)
  if (updates.length === 0) return []
  const cwd = resolve(context.sessionDir, commandDirectory(command, rawArgs) ?? context.sessionDir)
  const [source, session] = await Promise.all([
    repoLocation(context.exec, cwd),
    repoLocation(context.exec, context.sessionDir),
  ])
  const targets = await Promise.all(updates.map((update) => resolveTarget(update, source, session, context)))
  return targets.filter((target): target is PushTarget => target !== null)
}

async function resolveTarget(
  update: ParsedPushUpdate,
  source: RepoLocation | null,
  session: RepoLocation | null,
  context: ResolveContext,
): Promise<PushTarget | null> {
  const remote = parseRemote(update.remoteUrl)
  if (remote === null) return null
  const sourceSha =
    source === null ? null : await commitAtSource(context.exec, source.topLevel, update.srcRef)
  const sourceMatches =
    sourceSha !== null && (update.newShaPrefix === null || sourceSha.startsWith(update.newShaPrefix))
  const sha = sourceMatches
    ? sourceSha
    : await remoteCommit(context.exec, context.sessionDir, update.remoteUrl, update.dstBranch)
  if (sha === null) return null
  const sourceKind = sourceMatches ? classifySource(source, session) : "unknown"
  return {
    sha: sha as CommitSha,
    branch: update.dstBranch,
    repo: remote.repo,
    repoUrl: remote.repoUrl,
    directory: sourceKind === "unknown" ? null : (source?.topLevel ?? null),
    sourceKind,
  }
}

function commandDirectory(command: string, rawArgs: unknown): string | null {
  const args = RawArgsSchema.parse(rawArgs)
  if (args.workdir !== undefined) return args.workdir
  if (args.cwd !== undefined) return args.cwd
  const gitDirectory = command.match(/\bgit\s+-C\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))\s+push\b/)
  const fromGit = gitDirectory?.[1] ?? gitDirectory?.[2] ?? gitDirectory?.[3]
  if (fromGit !== undefined) return fromGit
  const leading = command.split(/&&|;/, 1)[0]?.trim() ?? ""
  const cdDirectory = leading.match(/^cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))$/)
  return cdDirectory?.[1] ?? cdDirectory?.[2] ?? cdDirectory?.[3] ?? null
}

async function repoLocation(exec: Exec, cwd: string): Promise<RepoLocation | null> {
  const [topLevel, gitDir, commonDir] = await Promise.all([
    exec(["git", "rev-parse", "--show-toplevel"], cwd),
    exec(["git", "rev-parse", "--absolute-git-dir"], cwd),
    exec(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], cwd),
  ])
  if (topLevel.exitCode !== 0 || gitDir.exitCode !== 0 || commonDir.exitCode !== 0) return null
  return {
    topLevel: topLevel.stdout.trim(),
    gitDir: gitDir.stdout.trim(),
    commonDir: commonDir.stdout.trim(),
  }
}

async function commitAtSource(exec: Exec, cwd: string, srcRef: string): Promise<string | null> {
  const result = await exec(["git", "rev-parse", "--verify", `${srcRef}^{commit}`], cwd)
  const sha = result.stdout.trim().toLowerCase()
  return result.exitCode === 0 && FULL_SHA.test(sha) ? sha : null
}

async function remoteCommit(
  exec: Exec,
  cwd: string,
  remoteUrl: string,
  branch: string,
): Promise<string | null> {
  const result = await exec(["git", "ls-remote", remoteUrl, `refs/heads/${branch}`], cwd)
  if (result.exitCode !== 0) return null
  const sha = result.stdout.trim().split(/\s+/, 1)[0]?.toLowerCase()
  return sha !== undefined && FULL_SHA.test(sha) ? sha : null
}

function classifySource(source: RepoLocation | null, session: RepoLocation | null): WatchSourceKind {
  if (source === null || session === null) return "unknown"
  if (source.topLevel === session.topLevel) return "session"
  if (source.commonDir === session.commonDir && source.gitDir !== source.commonDir) {
    return "linked-worktree"
  }
  return "external-repo"
}

function parseRemote(remoteUrl: string): Remote | null {
  const scp = remoteUrl.match(/^git@([^:]+):(.+)$/)
  if (scp?.[1] !== undefined && scp[2] !== undefined) {
    return remoteFromParts(scp[1], scp[2], `git@${scp[1]}:`)
  }
  let parsed: URL
  try {
    parsed = new URL(remoteUrl)
  } catch (error) {
    if (error instanceof TypeError) return null
    throw error
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null
  return remoteFromParts(parsed.host, parsed.pathname, `${parsed.protocol}//${parsed.host}/`)
}

function remoteFromParts(host: string, rawPath: string, prefix: string): Remote | null {
  const path = rawPath
    .replace(/^\/+/, "")
    .replace(/\.git\/?$/, "")
    .replace(/\/$/, "")
  if (path.split("/").length !== 2 || path.includes(" ")) return null
  return {
    repo: `${host.toLowerCase()}/${path.toLowerCase()}`,
    repoUrl: `${prefix}${path}`,
  }
}
