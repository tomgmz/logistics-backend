import { AccessToken, RoomServiceClient } from 'livekit-server-sdk'

/**
 * LiveKit, the voice transport for in-app calls: the driver's emergency call
 * and calls placed from Messages.
 *
 * Configured by three env vars from the LiveKit Cloud project (Settings → Keys):
 *   LIVEKIT_URL         wss://<project>.livekit.cloud
 *   LIVEKIT_API_KEY
 *   LIVEKIT_API_SECRET
 *
 * When they are missing, calling is simply OFF: the driver app sees the refusal
 * and goes straight to an ordinary phone call, and Messages says calling is not
 * set up. The emergency path must never depend on this being set up.
 */

const url    = process.env.LIVEKIT_URL ?? ''
const key    = process.env.LIVEKIT_API_KEY ?? ''
const secret = process.env.LIVEKIT_API_SECRET ?? ''

export function isLiveKitConfigured(): boolean {
  return !!(url && key && secret)
}

export function liveKitUrl(): string {
  return url
}

/**
 * A join token for one room. Voice only: publishing is allowed but the client
 * only ever sends a microphone track. Short-lived, because an emergency call
 * that has not started within the hour is not going to.
 */
export async function mintRoomToken(params: {
  room:     string
  identity: string
  name:     string
}): Promise<string> {
  const token = new AccessToken(key, secret, {
    identity: params.identity,
    name:     params.name,
    ttl:      '1h',
  })
  token.addGrant({
    roomJoin:     true,
    room:         params.room,
    canPublish:   true,
    canSubscribe: true,
    canPublishData: false,
  })
  return token.toJwt()
}

/**
 * How many people are in a room right now, or null when LiveKit could not be
 * asked. A room nobody ever joined reads as 0.
 */
export async function roomParticipantCount(room: string): Promise<number | null> {
  if (!isLiveKitConfigured()) return null
  try {
    const httpUrl = url.replace(/^ws/, 'http')
    return (await new RoomServiceClient(httpUrl, key, secret).listParticipants(room)).length
  } catch (e: any) {
    // LiveKit answers "room not found" for a room that is gone or never existed.
    return /not.?found/i.test(String(e?.message ?? '')) ? 0 : null
  }
}

/** Close a room so nobody is left talking into it. Best effort. */
export async function closeRoom(room: string): Promise<void> {
  if (!isLiveKitConfigured()) return
  try {
    const httpUrl = url.replace(/^ws/, 'http')
    await new RoomServiceClient(httpUrl, key, secret).deleteRoom(room)
  } catch {
    // The room may never have been created (nobody joined) — nothing to close.
  }
}
