import { type HostClient, HostRequestError, type HostRequestErrorCode } from "@openchamber/sdk"
import type { InvalidDataReason, Parsed } from "./schemas.ts"

/** The part of the SDK host client the binding needs; tests pass a fake. */
export type BindingHost = Pick<HostClient, "watchLoopback" | "loopbackRequest">

/** Why a finite loopback request produced no value. */
export type RequestFailure =
  | { readonly kind: "forbidden" }
  | {
      readonly kind: "unavailable"
      readonly code: HostRequestErrorCode | null
      readonly status: number | null
    }
  /** The plugin answered 4xx (bad body, unknown route, …); `message` is its plain-text reason. */
  | { readonly kind: "rejected"; readonly status: number; readonly message: string }
  | { readonly kind: "invalid-data"; readonly reason: InvalidDataReason }

export type RequestOutcome<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "failed"; readonly failure: RequestFailure }

const FORBIDDEN_CODES: ReadonlySet<HostRequestErrorCode> = new Set(["NOT_GRANTED", "DENIED", "DISABLED"])

export function failureFromError(error: unknown): RequestFailure {
  if (!(error instanceof HostRequestError)) return { kind: "unavailable", code: null, status: null }
  return FORBIDDEN_CODES.has(error.code)
    ? { kind: "forbidden" }
    : { kind: "unavailable", code: error.code, status: null }
}

function failureFromStatus(status: number, body: string): RequestFailure {
  if (status === 403) return { kind: "forbidden" }
  if (status >= 500) return { kind: "unavailable", code: null, status }
  return { kind: "rejected", status, message: body.slice(0, 200) }
}

type LoopbackCall = Parameters<BindingHost["loopbackRequest"]>[0]

/** One request, parsed once at this boundary; transport errors become typed failures. */
export async function loopbackCall<T>(
  host: BindingHost,
  call: LoopbackCall,
  parse: (text: string) => Parsed<T>,
): Promise<RequestOutcome<T>> {
  let response: Awaited<ReturnType<BindingHost["loopbackRequest"]>>
  try {
    response = await host.loopbackRequest(call)
  } catch (error) {
    return { kind: "failed", failure: failureFromError(error) }
  }
  if (response.status < 200 || response.status > 299) {
    return { kind: "failed", failure: failureFromStatus(response.status, response.body) }
  }
  const parsed = parse(response.body)
  return parsed.ok
    ? { kind: "ok", value: parsed.value }
    : { kind: "failed", failure: { kind: "invalid-data", reason: parsed.reason } }
}
