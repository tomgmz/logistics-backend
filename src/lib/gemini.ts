import { logSystemThrottled, EXTERNAL_FAILURE_LOG_WINDOW_MS } from './log-system.js'

/**
 * Google Gemini (the Gemini API, generativelanguage.googleapis.com): the model
 * behind the client help assistant's grounded answers.
 *
 * One plain HTTPS call; no SDK. Keep every Gemini call behind this file so the
 * provider can be swapped (another model or a hosted Llama) without touching
 * the assistant.
 *
 * Env:
 *   GEMINI_API_KEY         required. Unset = not configured: the assistant falls
 *                          back to the keyword FAQ and System Logs says so once
 *                          an hour. Free tier in use (thesis project, user
 *                          2026-11-18): Google may use prompts and answers to
 *                          improve its products and people may read them. Turn
 *                          on billing (same key) before real clients use it.
 *   GEMINI_MODEL           optional, default gemini-3.5-flash-lite.
 *   GEMINI_FALLBACK_MODEL  optional, default gemini-3.1-flash-lite; tried once
 *                          when the first model is busy (503), rate-limited
 *                          (429) or too slow. "none" turns the retry off.
 *
 * Why Flash-Lite (checked 2026-11-18 on the free tier): gemini-2.5-flash and
 * 2.5-flash-lite are closed to new keys (404); the full Flash models
 * (3.5 / 3.7 / 3.8) answered 503 "high demand" or took 20 s to over 2 minutes;
 * 3.5-flash-lite, 3.1-flash-lite and flash-lite-latest answered in 1-2 s. A
 * short grounded lookup doesn't need the bigger model.
 */

const DEFAULT_MODEL          = 'gemini-3.5-flash-lite'
const DEFAULT_FALLBACK_MODEL = 'gemini-3.1-flash-lite'
/** Per attempt; with the fallback a question waits at most twice this. */
const TIMEOUT_MS             = 9_000

export function geminiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY)
}

export function geminiModel(): string {
  return (process.env.GEMINI_MODEL ?? '').trim() || DEFAULT_MODEL
}

function fallbackModel(): string | null {
  const v = (process.env.GEMINI_FALLBACK_MODEL ?? '').trim()
  if (v.toLowerCase() === 'none') return null
  const m = v || DEFAULT_FALLBACK_MODEL
  return m === geminiModel() ? null : m
}

/** A subset of the OpenAPI schema Gemini accepts for structured output. */
export interface GeminiSchema {
  type:        'OBJECT' | 'STRING' | 'ARRAY' | 'BOOLEAN' | 'INTEGER' | 'NUMBER'
  properties?: Record<string, GeminiSchema>
  required?:   string[]
  items?:      GeminiSchema
  enum?:       string[]
  description?: string
}

export type GeminiJsonResult<T> =
  | { outcome: 'ok'; data: T; model: string }
  /** No key, a refused key, Google not answering, a blocked or cut-off reply. */
  | { outcome: 'unavailable'; reason: string }

interface CallInput {
  system:           string
  user:             string
  schema:           GeminiSchema
  maxOutputTokens?: number
  /** For System Logs: what the call was for. */
  purpose:          string
}

type Attempt =
  | { kind: 'ok'; text: string }
  /** Worth trying the fallback model: busy, rate-limited, slow, model gone. */
  | { kind: 'retry'; status: number; message: string }
  /** Not worth retrying: a bad key, a blocked or cut-off reply. */
  | { kind: 'stop'; status: number; message: string; keyProblem: boolean; reason: string }

async function attempt(model: string, key: string, input: CallInput): Promise<Attempt> {
  const generationConfig: Record<string, unknown> = {
    temperature:      0,
    maxOutputTokens:  input.maxOutputTokens ?? 512,
    responseMimeType: 'application/json',
    responseSchema:   input.schema,
  }
  // Flash models "think" before answering by default, which only adds time to
  // a short lookup. 2.5 Flash turns it off with a budget of 0; Gemini 3 and
  // later take a level instead, and their lowest accepted level is 'low'
  // ('minimal' is refused by 3.8 Flash).
  if (/2\.5-flash/.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 }
  else if (/flash/.test(model))  generationConfig.thinkingConfig = { thinkingLevel: 'low' }

  let status = 0
  let body: any
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body:    JSON.stringify({
          systemInstruction: { parts: [{ text: input.system }] },
          contents:          [{ role: 'user', parts: [{ text: input.user }] }],
          generationConfig,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    )
    status = res.status
    body   = await res.json().catch(() => null)
  } catch (err: any) {
    return { kind: 'retry', status: 0, message: err?.name === 'TimeoutError' ? `no answer within ${TIMEOUT_MS / 1000} s` : (err?.message ?? String(err)) }
  }

  if (status !== 200) {
    const message = body?.error?.message ?? `Gemini answered ${status}`
    const keyProblem = (status === 400 && /api key/i.test(message)) || status === 401 || status === 403
    if (keyProblem) return { kind: 'stop', status, message, keyProblem, reason: 'key' }
    // Busy, rate-limited, model withdrawn, server error: another model may answer.
    if (status === 429 || status === 404 || status >= 500) return { kind: 'retry', status, message }
    return { kind: 'stop', status, message, keyProblem: false, reason: 'error' }
  }

  // Blocked by Google's safety filter, or a reply that didn't finish: no answer.
  const candidate = body?.candidates?.[0]
  const text: string | undefined = candidate?.content?.parts?.map((p: any) => p?.text ?? '').join('')
  if (body?.promptFeedback?.blockReason || !candidate || candidate.finishReason !== 'STOP' || !text) {
    const reason = body?.promptFeedback?.blockReason ? 'blocked' : `finish_${candidate?.finishReason ?? 'none'}`
    return { kind: 'stop', status, message: reason, keyProblem: false, reason }
  }
  return { kind: 'ok', text }
}

/**
 * One request with a system instruction and one user turn, answered as JSON
 * matching `schema`. Temperature 0: the same question gets the same answer.
 * The fallback model is tried once when the first is busy or slow.
 */
export async function geminiJson<T>(input: CallInput): Promise<GeminiJsonResult<T>> {
  const key = process.env.GEMINI_API_KEY ?? ''
  if (!key) {
    logSystemThrottled('gemini.not-configured', 60 * 60_000, {
      log_level:  'warn',
      event_type: 'external_api',
      source:     'gemini.config',
      message:    `GEMINI_API_KEY is not set, so the ${input.purpose} uses its keyword answers only.`,
      metadata:   {},
    })
    return { outcome: 'unavailable', reason: 'not_configured' }
  }

  const models = [geminiModel(), fallbackModel()].filter((m): m is string => !!m)
  const failures: string[] = []
  for (const model of models) {
    const a = await attempt(model, key, input)
    if (a.kind === 'ok') {
      try {
        return { outcome: 'ok', data: JSON.parse(a.text) as T, model }
      } catch {
        return { outcome: 'unavailable', reason: 'bad_json' }
      }
    }
    if (a.kind === 'stop') {
      if (a.keyProblem) {
        logSystemThrottled('gemini.key', 60 * 60_000, {
          log_level:  'error',
          event_type: 'external_api',
          source:     'gemini.config',
          message:    `Google refused GEMINI_API_KEY (${a.message}), so the ${input.purpose} uses its keyword answers only.`,
          metadata:   { model, status: a.status },
        })
      }
      return { outcome: 'unavailable', reason: a.reason }
    }
    failures.push(`${model}: ${a.status ? `${a.status} ` : ''}${a.message}`)
  }

  logSystemThrottled('gemini.call', EXTERNAL_FAILURE_LOG_WINDOW_MS, {
    log_level:  'error',
    event_type: 'external_api',
    source:     'gemini.call',
    message:    `Gemini did not answer (${failures.join('; ')}), so the ${input.purpose} fell back to its keyword answers.`,
    metadata:   { models },
  })
  return { outcome: 'unavailable', reason: 'busy' }
}
