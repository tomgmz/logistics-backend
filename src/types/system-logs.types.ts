export type LogType =
  | 'user_activity'
  | 'vehicle_creation'
  | 'vehicle_activity'
  | 'booking'
  | 'payment'
  | 'system_error'
  | 'driver_activity'
  | 'billing_activity'
  | 'delivery_activity'
  | 'maintenance_activity'
  | 'auth'

export interface SystemLog {
  log_id:       string
  user_id?:     string | null
  log_type:     LogType
  action:       string
  description?: string | null
  timestamp:    Date

  role?:        string | null
  first_name?:  string | null
  last_name?:   string | null
}

export interface GetLogsQuery {
  log_type?:  LogType
  search?:    string
  sort?:      'asc' | 'desc'
  page?:      number
  limit?:     number
}