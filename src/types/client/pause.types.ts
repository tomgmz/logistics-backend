/**
 * A driver pausing a delivery: weather, a breakdown, a closed pickup or drop-off.
 * See the 20261016000000_trip_pauses migration for why it is a flag on the
 * booking rather than a booking status.
 */

export const PAUSE_REASONS = [
  'weather',
  'vehicle_breakdown',
  'pickup_closed',
  'dropoff_closed',
  'road_closed',
  'other',
] as const

export type PauseReason = typeof PAUSE_REASONS[number]

/** How each reason reads to people — the client sees exactly this, nothing more. */
export const PAUSE_REASON_LABEL: Record<PauseReason, string> = {
  weather:           'Bad weather',
  vehicle_breakdown: 'Vehicle breakdown',
  pickup_closed:     'Pickup point closed',
  dropoff_closed:    'Drop-off point closed',
  road_closed:       'Road closed',
  other:             'Other',
}

export type ResumedVia = 'driver' | 'staff' | 'auto'

export interface BookingPause {
  pause_id:    string
  booking_id:  string
  trip_id:     string | null
  reason:      PauseReason
  note:        string
  paused_by:   string | null
  paused_at:   string
  latitude:    number | null
  longitude:   number | null
  accuracy_m:  number | null
  report_id:   string | null
  resumed_at:  string | null
  resumed_by:  string | null
  resumed_via: ResumedVia | null
  resume_note: string | null
  created_at:  string
}

/** Staff history read: the pause plus who started and ended it. */
export interface BookingPauseWithActors extends BookingPause {
  pauser:  { first_name: string | null; last_name: string | null } | null
  resumer: { first_name: string | null; last_name: string | null } | null
}

export interface PauseTripInput {
  reason:      PauseReason
  note:        string
  /** When the driver pressed Pause, as the phone recorded it. */
  paused_at?:  string | null
  latitude?:   number | null
  longitude?:  number | null
  accuracy_m?: number | null
}
