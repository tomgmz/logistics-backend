/**
 * An error that already knows what HTTP status it deserves.
 *
 * Controllers used to infer the status by matching substrings of the message —
 * `message.includes('required')`, `includes('at most')`, and so on. Every new
 * rule then had to remember to phrase itself in a way the controller happened to
 * recognise, and one that did not fell through to a 500: refusing a Sunday
 * booking, a plain input error, was reported to the client as a server fault
 * because its wording matched none of the patterns.
 *
 * Throwing this instead states the intent once, where the rule lives.
 */
export class HttpError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

/** The request is wrong: a rule the caller can see and correct. */
export const badRequest = (message: string) => new HttpError(400, message)

/** Nothing here — or nothing this caller is allowed to know about. */
export const notFound = (message: string) => new HttpError(404, message)

/** The request is fine, but the record is not in a state that allows it. */
export const conflict = (message: string) => new HttpError(409, message)

/**
 * The status an error should be reported with. Anything that is not an
 * `HttpError` is a fault on our side until proven otherwise.
 */
export function statusOf(error: unknown, fallback = 500): number {
  return error instanceof HttpError ? error.status : fallback
}
