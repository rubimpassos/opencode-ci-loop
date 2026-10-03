// Fails when a committed guest bundle differs from a fresh build. Never rewrites the committed files.
import { relative } from "node:path"
import { buildExtensionBundles } from "./extension-bundles.ts"

const stale: string[] = []
for (const bundle of await buildExtensionBundles()) {
  const committed = Bun.file(bundle.outfile)
  const current = (await committed.exists()) ? new Uint8Array(await committed.arrayBuffer()) : null
  const same =
    current !== null &&
    current.byteLength === bundle.bytes.byteLength &&
    current.every((byte, index) => byte === bundle.bytes[index])
  if (!same) stale.push(relative(process.cwd(), bundle.outfile))
}
if (stale.length > 0) {
  console.error(`stale extension bundles (run \`bun run build:extension\`): ${stale.join(", ")}`)
  process.exit(1)
}
console.log("extension bundles are up to date")
