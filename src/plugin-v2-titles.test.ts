import { expect, it } from "bun:test"
import { CATALOGS } from "./i18n.ts"
import type { PanelSnapshot } from "./panel-types.ts"
import { setupV2 } from "./plugin-v2.ts"
import { pushFixture } from "./v2-push-fixture.test.ts"

type Fixture = ReturnType<typeof pushFixture>

/** Counts session reads without changing the rest of the SDK seam. */
function countingTitles(fixture: Fixture) {
  const reads: string[] = []
  const ctx = {
    ...fixture.ctx,
    session: {
      ...fixture.ctx.session,
      get: async (...args: Parameters<Fixture["ctx"]["session"]["get"]>) => {
        reads.push(args[0].sessionID)
        return fixture.ctx.session.get(...args)
      },
    },
  }
  return { ctx, reads }
}

async function panel(fixture: Fixture, query = ""): Promise<PanelSnapshot> {
  return (await (await fetch(`http://127.0.0.1:${fixture.port}/panel/state${query}`)).json()) as PanelSnapshot
}

/** The title read is fire-and-forget after a push; wait for it to land instead of sleeping. */
async function settledTitles(fixture: Fixture): Promise<readonly (string | null)[]> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const titles = (await panel(fixture)).sessions.map((session) => session.title)
    if (titles.some((title) => title !== null)) return titles
    await Bun.sleep(10)
  }
  return (await panel(fixture)).sessions.map((session) => session.title)
}

it("reads the session title once when a watch starts and shows it on the panel", async () => {
  // Given a plugin whose session is titled "fixture".
  using fixture = pushFixture()
  const { ctx, reads } = countingTitles(fixture)
  const cleanup = await setupV2(ctx)
  try {
    // When the same session pushes twice.
    await fixture.after(fixture.event)
    expect(await settledTitles(fixture)).toEqual(["fixture"])
    await fixture.after(fixture.event)
    // Then each push read the session's location, and only the first one read its title.
    expect(reads).toHaveLength(3)
  } finally {
    await cleanup()
  }
})

it("serves each viewer the locale it asks for and keeps /state free of titles", async () => {
  // Given a watched session.
  using fixture = pushFixture()
  const cleanup = await setupV2(fixture.ctx)
  try {
    await fixture.after(fixture.event)
    // When two viewers ask for different locales and a client reads the raw state.
    const pt = await panel(fixture, "?locale=pt-BR")
    const en = await panel(fixture, "?locale=en")
    const raw = (await (await fetch(`http://127.0.0.1:${fixture.port}/state`)).json()) as Record<
      string,
      unknown
    >[]
    // Then each viewer gets its catalog, and the raw contract keeps its original fields.
    expect(pt.chrome.searchPlaceholder).toBe(CATALOGS["pt-BR"].panelSearchPlaceholder)
    expect(en.chrome.searchPlaceholder).toBe(CATALOGS.en.panelSearchPlaceholder)
    expect(Object.keys(raw[0] ?? {}).sort()).toEqual([
      "directory",
      "enabled",
      "sessionID",
      "watch",
      "watches",
    ])
  } finally {
    await cleanup()
  }
})
