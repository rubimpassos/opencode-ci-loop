// Bundles each guest page script into the classic IIFE an OpenChamber guest frame loads. The output
// is committed next to its entry so a folder/git/npm install needs no build step.
import { resolve } from "node:path"

const root = resolve(import.meta.dir, "..")

export const EXTENSION_ENTRIES = ["panel", "status", "background"] as const

export type Bundle = { readonly outfile: string; readonly bytes: Uint8Array }

export async function buildExtensionBundles(): Promise<readonly Bundle[]> {
  const bundles: Bundle[] = []
  for (const name of EXTENSION_ENTRIES) {
    const result = await Bun.build({
      entrypoints: [resolve(root, name, "main.ts")],
      format: "iife",
      target: "browser",
      minify: true,
    })
    const artifact = result.outputs[0]
    if (!result.success || artifact === undefined) {
      const logs = result.logs.map((log) => log.message).join("\n")
      throw new Error(logs || `build failed: ${name}/main.ts`)
    }
    bundles.push({
      outfile: resolve(root, name, "main.js"),
      bytes: new Uint8Array(await artifact.arrayBuffer()),
    })
  }
  return bundles
}
