import Expo, { ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk'
import webpush from 'web-push'
import * as model from '../../models/messaging/push.model.js'
import { logSystemThrottled, EXTERNAL_FAILURE_LOG_WINDOW_MS } from '../../lib/log-system.js'

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY
const VAPID_SUBJECT = process.env.VAPID_SUBJECT ?? 'mailto:support@logistics8338.ph'

const webPushEnabled = Boolean(VAPID_PUBLIC && VAPID_PRIVATE)
if (webPushEnabled) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC!, VAPID_PRIVATE!)
} else {
  console.warn('[push] VAPID keys missing — web push disabled')
}

const expo = new Expo(
  process.env.EXPO_ACCESS_TOKEN ? { accessToken: process.env.EXPO_ACCESS_TOKEN } : undefined
)

export interface PushPayload {
  title: string
  body:  string
  data:  Record<string, unknown>
}

export async function registerSubscription(
  userId: string,
  input: {
    platform:     'web' | 'expo'
    token:        string
    keys?:        { p256dh: string; auth: string } | null
    device_info?: string | null
  }
): Promise<void> {
  await model.upsertSubscription({ user_id: userId, ...input })
}

export async function unregister(token: string): Promise<void> {
  await model.deleteByToken(token)
}

export function preview(content: string): string {
  const t = content.trim()
  return t.length > 120 ? `${t.slice(0, 119)}…` : t
}

export const getDisplayName = model.getDisplayName

async function sendExpo(subs: model.PushSubscriptionRow[], payload: PushPayload): Promise<string[]> {
  const dead: string[] = []
  const messages: ExpoPushMessage[] = []
  const validSubs: model.PushSubscriptionRow[] = []

  for (const s of subs) {
    if (!Expo.isExpoPushToken(s.token)) { dead.push(s.token); continue }
    validSubs.push(s)
    messages.push({
      to:    s.token,
      title: payload.title,
      body:  payload.body,
      data:  payload.data,
      sound: 'default',
      priority: 'high',
      channelId: 'messages',
    })
  }

  const chunks = expo.chunkPushNotifications(messages)
  const tickets: ExpoPushTicket[] = []
  for (const chunk of chunks) {
    try {
      tickets.push(...(await expo.sendPushNotificationsAsync(chunk)))
    } catch (err) {
      console.error('[push] expo chunk error', err)
      logSystemThrottled('push.expo', EXTERNAL_FAILURE_LOG_WINDOW_MS, {
        log_level:  'error',
        event_type: 'external_api',
        source:     'push.expo',
        message:    `Expo push send failed: ${(err as Error)?.message ?? String(err)}`,
        metadata:   { messages: chunk.length },
      })
    }
  }

  let ticketErrors = 0
  let lastTicketError: string | undefined
  tickets.forEach((ticket, i) => {
    if (ticket.status !== 'error') return
    if (ticket.details?.error === 'DeviceNotRegistered') {
      const token = validSubs[i]?.token
      if (token) dead.push(token)
      return
    }
    // An uninstalled app is routine and pruned above; anything else
    // (credentials, rate limits, payload) is the provider refusing us.
    ticketErrors++
    lastTicketError = ticket.details?.error ?? ticket.message
  })
  if (ticketErrors > 0) {
    logSystemThrottled('push.expo', EXTERNAL_FAILURE_LOG_WINDOW_MS, {
      log_level:  'warn',
      event_type: 'external_api',
      source:     'push.expo',
      message:    `Expo rejected ${ticketErrors} push message(s): ${lastTicketError ?? 'unknown error'}`,
      metadata:   { rejected: ticketErrors, sent: tickets.length },
    })
  }

  return dead
}

async function sendWeb(subs: model.PushSubscriptionRow[], payload: PushPayload): Promise<string[]> {
  if (!webPushEnabled) return []
  const dead: string[] = []
  const body = JSON.stringify(payload)

  await Promise.allSettled(
    subs.map(async (s) => {
      if (!s.keys) { dead.push(s.token); return }
      try {
        await webpush.sendNotification(
          { endpoint: s.token, keys: s.keys },
          body
        )
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode
        if (status === 404 || status === 410) dead.push(s.token)
        else {
          console.error('[push] web push error', status, err)
          logSystemThrottled('push.web', EXTERNAL_FAILURE_LOG_WINDOW_MS, {
            log_level:  'warn',
            event_type: 'external_api',
            source:     'push.web',
            message:    `Web push failed: ${(err as Error)?.message ?? String(err)}`,
            metadata:   { status: status ?? null },
          })
        }
      }
    })
  )

  return dead
}

/** Best-effort fan-out. Never throws into the caller's request path. */
export async function sendToUsers(userIds: string[], payload: PushPayload): Promise<void> {
  try {
    const subs = await model.getSubscriptionsForUsers([...new Set(userIds)])
    if (subs.length === 0) return

    const expoSubs = subs.filter((s) => s.platform === 'expo')
    const webSubs  = subs.filter((s) => s.platform === 'web')

    const [expoDead, webDead] = await Promise.all([
      sendExpo(expoSubs, payload),
      sendWeb(webSubs, payload),
    ])

    const dead = [...expoDead, ...webDead]
    if (dead.length) await model.deleteTokens(dead).catch((e) => console.error('[push] prune error', e))
  } catch (err) {
    console.error('[push] sendToUsers failed', err)
  }
}
