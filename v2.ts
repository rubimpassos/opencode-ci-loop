import { Plugin } from "@opencode/plugin"
import { setupV2 } from "./src/plugin-v2.ts"

// biome-ignore lint/style/noDefaultExport: OpenCode V2 discovers the default plugin definition.
export default Plugin.define({ id: "ci-loop", setup: setupV2 })
