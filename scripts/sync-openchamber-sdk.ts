// Vendors the OpenChamber fork's SDK (with the loopback host API that is not published yet) as a
// build-only archive. Usage: bun scripts/sync-openchamber-sdk.ts <openchamber checkout>
import { createHash } from "node:crypto"
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { z } from "zod"

const ARCHIVE = "openchamber-sdk-loopback.tgz"
const vendorDir = resolve(import.meta.dir, "..", "vendor")

const PackResult = z
  .array(z.object({ filename: z.string(), version: z.string(), name: z.string() }))
  .length(1)
const SdkManifest = z.object({
  name: z.literal("@openchamber/sdk"),
  version: z.string(),
  license: z.string(),
})

async function run(cmd: readonly string[], cwd: string): Promise<string> {
  const proc = Bun.spawn([...cmd], { cwd, stdout: "pipe", stderr: "inherit" })
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  if (code !== 0) throw new Error(`${cmd.join(" ")} exited ${code} in ${cwd}`)
  return out.trim()
}

const sourceArg = process.argv[2]
if (sourceArg === undefined) {
  console.error("usage: bun scripts/sync-openchamber-sdk.ts <openchamber checkout>")
  process.exit(2)
}
const source = resolve(sourceArg)
const sdkDir = join(source, "packages", "sdk")

const commit = await run(["git", "rev-parse", "HEAD"], source)
const dirty = await run(["git", "status", "--porcelain", "--", "packages/sdk"], source)
if (dirty !== "") throw new Error(`packages/sdk has uncommitted changes; refusing to vendor:\n${dirty}`)

const sdk = SdkManifest.parse(JSON.parse(await readFile(join(sdkDir, "package.json"), "utf8")))
await run(["bun", "run", "clean"], sdkDir)
await run(["bun", "run", "build"], sdkDir)

const scratch = await mkdtemp(join(tmpdir(), "ci-loop-sdk-"))
try {
  const packed = PackResult.parse(
    JSON.parse(await run(["npm", "pack", "--json", "--pack-destination", scratch], sdkDir)),
  )[0]
  if (packed === undefined) throw new Error("npm pack produced no archive")
  await copyFile(join(scratch, packed.filename), join(vendorDir, ARCHIVE))
} finally {
  await rm(scratch, { recursive: true, force: true })
}

const sha256 = createHash("sha256")
  .update(await readFile(join(vendorDir, ARCHIVE)))
  .digest("hex")
await writeFile(
  join(vendorDir, "README.md"),
  `# Vendored OpenChamber SDK

\`${ARCHIVE}\` is \`${sdk.name}@${sdk.version}\` packed from the OpenChamber fork, which adds the
guest loopback host API (\`loopbackUrl\`, \`loopbackRequest\`, \`watchLoopback\`) and the \`loopback\`
manifest contribution. Those APIs are not in a published SDK release yet; this archive is a
reversible stopgap until they are.

- Source: \`packages/sdk\` of the OpenChamber fork
- Commit: \`${commit}\`
- SHA-256: \`${sha256}\`
- License: ${sdk.license} (see \`package/LICENSE\` inside the archive)

Build-only: it is a devDependency used to bundle \`panel/\`, \`status/\` and \`background/\`.
It is not part of the published plugin package and the plugin runtime never loads it.

Regenerate: \`bun scripts/sync-openchamber-sdk.ts <openchamber checkout>\`, then \`bun install\`.
`,
)
console.log(`vendored ${sdk.name}@${sdk.version} from ${commit} sha256=${sha256}`)
