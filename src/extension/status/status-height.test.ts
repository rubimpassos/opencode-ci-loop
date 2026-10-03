import { expect, it } from "bun:test"
import { trackStatusHeight } from "./status-height.ts"

it("deduplicates measured heights, clamps empty/expanded content and disconnects on dispose", () => {
  // Given: a resizable content area and a host that records sizing requests.
  let measured = 12
  let resize: () => void = () => {}
  let disconnected = false
  const heights: number[] = []
  const reporter = trackStatusHeight(
    () => measured,
    (height) => {
      heights.push(height)
      return Promise.resolve()
    },
    (callback) => {
      resize = callback
      return () => {
        disconnected = true
      }
    },
  )
  // When: the area first renders, grows, and emits redundant resize callbacks.
  reporter.fit()
  measured = 58.2
  resize()
  measured = 58.4
  resize()
  measured = 400
  resize()
  reporter.dispose()
  measured = 90
  resize()
  // Then: only actual clamped height changes reach the host; the observer is cleaned up.
  expect(heights).toEqual([24, 59, 320])
  expect(disconnected).toBe(true)
})
