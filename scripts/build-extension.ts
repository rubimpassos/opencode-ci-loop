import { relative } from "node:path"
import { buildExtensionBundles } from "./extension-bundles.ts"

for (const bundle of await buildExtensionBundles()) {
  await Bun.write(bundle.outfile, bundle.bytes)
  console.log(`${relative(process.cwd(), bundle.outfile)} ${bundle.bytes.byteLength} bytes`)
}
