import { expect, it } from "bun:test"
import { setupV2 } from "./plugin-v2.ts"
import { SID, v2Fixture } from "./v2-fixture.test.ts"
import { pushFixture } from "./v2-push-fixture.test.ts"

it("updates the panel title when an owned session is renamed", async () => {
  // Given a session claimed by ci_watch.
  using fixture = v2Fixture()
  const cleanup = await setupV2(fixture.ctx)
  try {
    await fixture.execute({ action: "enable" })
    // When V2 publishes its public title-update event.
    await fixture.send({
      id: "evt_rename",
      created: 1,
      type: "session.renamed",
      durable: { aggregateID: SID, seq: 1, version: 1 },
      data: { sessionID: SID, title: "updated-title" },
    })
    // Then the real panel is republished with the new title.
    expect(await (await fetch(`http://127.0.0.1:${fixture.port}/panel/state`)).json()).toMatchObject({
      sessions: [{ sessionID: SID, title: "updated-title" }],
    })
  } finally {
    await cleanup()
  }
})

it("removes the active watch when its owned session is deleted", async () => {
  // Given a real registered push watch in its initial abortable wait.
  using fixture = pushFixture()
  const cleanup = await setupV2(fixture.ctx)
  try {
    await fixture.after(fixture.event)
    // When the host removes the session.
    await fixture.send({
      id: "evt_delete",
      created: 1,
      type: "session.deleted",
      durable: { aggregateID: SID, seq: 1, version: 2 },
      data: { sessionID: SID },
    })
    // Then it disappears from the real dashboard rather than continuing as an orphan watch.
    expect(await (await fetch(`http://127.0.0.1:${fixture.port}/state`)).json()).toEqual([])
  } finally {
    await cleanup()
  }
})

it("ignores deletion when another plugin instance owns the session", async () => {
  // Given two locations sharing a runtime but only the first has claimed the session.
  using owner = pushFixture()
  using observer = v2Fixture()
  const cleanupOwner = await setupV2(owner.ctx)
  const cleanupObserver = await setupV2({ ...observer.ctx, options: owner.ctx.options })
  try {
    await owner.after(owner.event)
    // When the foreign observer receives a delete event.
    await observer.send({
      id: "evt_foreign",
      created: 1,
      type: "session.deleted",
      durable: { aggregateID: SID, seq: 1, version: 2 },
      data: { sessionID: SID },
    })
    // Then the owner's watch remains intact.
    expect(await (await fetch(`http://127.0.0.1:${owner.port}/state`)).json()).toMatchObject([
      { sessionID: SID, watches: [{ sha: owner.sha }] },
    ])
  } finally {
    await cleanupObserver()
    await cleanupOwner()
  }
})
