import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** Secrets are registered before use; only sanitized copies leave the private scratch. */
export class Artifacts {
  secrets = new Set()

  constructor(root) {
    this.root = root
    mkdirSync(root, { recursive: true })
  }

  redact(text) {
    let result = text
    for (const secret of this.secrets) {
      if (secret) result = result.replaceAll(secret, "[REDACTED]")
    }
    return result
      .replace(/(oc_url_token=)[^\s&"']+/g, "$1[REDACTED]")
      .replace(/(authorization["']?\s*[:=]\s*["']?)(?:Bearer|Basic)\s+[^\s"']+/gi, "$1[REDACTED]")
  }

  text(name, content) {
    const file = join(this.root, name)
    mkdirSync(join(file, ".."), { recursive: true })
    writeFileSync(file, this.redact(content))
  }

  json(name, value) {
    this.text(name, `${JSON.stringify(value, null, 2)}\n`)
  }

  logs(source, scenario = "stack") {
    for (const file of readdirSync(source)) {
      this.text(`${scenario}/${file}`, readFileSync(join(source, file), "utf8"))
    }
  }
}
