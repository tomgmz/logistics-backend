import type { BlowbagetsItems } from '../client/booking.types.js'

/**
 * What the driver raises from the road.
 *
 * 'quick'    — the SOS path: one tap and a countdown, may carry nothing but a position
 * 'detailed' — the same row with the fields the driver had time to supply
 */
export type ReportSource = 'quick' | 'detailed'

export type IncidentType =
  | 'accident'
  | 'vehicle_breakdown'
  | 'health_emergency'
  | 'security_threat'

/** 'reported' — nobody has picked it up; 'acknowledged' — seen; 'resolved' — dealt with. */
export type ReportStatus = 'reported' | 'acknowledged' | 'resolved'

/** The driver's own vehicle re-check, offered on a breakdown report. */
export interface DriverBlowbagetsCheck {
  items:      BlowbagetsItems
  checked_at: string
}

export interface DriverReport {
  report_id:  string
  driver_id:  string
  booking_id: string | null
  truck_id:   string | null

  source:        ReportSource
  /** NULL on a quick alert sent without picking a tile — "Unspecified Emergency". */
  incident_type: IncidentType | null
  sub_type:      string | null
  description:   string | null

  photo_urls: string[]
  video_urls: string[]

  latitude:   number | null
  longitude:  number | null
  accuracy_m: number | null
  address:    string | null

  blowbagets_check:  DriverBlowbagetsCheck | null
  trip_can_continue: boolean | null

  status:          ReportStatus
  acknowledged_by: string | null
  acknowledged_at: string | null
  resolved_by:     string | null
  resolved_at:     string | null
  resolution_note: string | null

  created_at: string
  updated_at: string

  // joined
  bookings?: { booking_id: string; reference_number: string | null; origin: string } | null
  trucks?:   { truck_id: string; plate_number: string; truck_models?: { name: string | null; vehicle_type: string | null } | null } | null
}

export interface CreateDriverReportInput {
  booking_id?:        string | null
  truck_id?:          string | null
  source:             ReportSource
  incident_type?:     IncidentType | null
  sub_type?:          string | null
  description?:       string | null
  photo_urls?:        string[]
  video_urls?:        string[]
  latitude?:          number | null
  longitude?:         number | null
  accuracy_m?:        number | null
  address?:           string | null
  blowbagets_items?:  BlowbagetsItems | null
  trip_can_continue?: boolean | null
}
