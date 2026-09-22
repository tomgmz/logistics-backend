/**
 * Business audit trail. Every row here answers "who did what to which record".
 * Technical events belong in system-logs.types.ts instead.
 */
export type LogType =
  // A person acted on their own credentials or session.
  | 'auth'
  // An admin created, changed, or removed somebody else's account.
  | 'user_management'
  // Permissions granted or revoked, and attempts that were refused.
  | 'access_control'
  // A document or proof photo was attached or removed.
  | 'document_activity'
  // Records left the system in bulk.
  | 'data_export'
  // Domain activity.
  | 'admin_activity'
  | 'vehicle_creation'
  | 'vehicle_activity'
  | 'booking'
  | 'payment'
  | 'driver_activity'
  | 'billing_activity'
  | 'delivery_activity'
  | 'maintenance_activity'
  /**
   * @deprecated Split into 'auth' (self-service) and 'user_management' (an
   * admin acting on an account) — it was absorbing both and neither was
   * findable. Still accepted by the CHECK constraint so old rows and any
   * straggler call site keep working; write one of the two instead.
   */
  | 'user_activity'
  /** @deprecated Technical failures now go to system_logs. */
  | 'system_error'

export interface AuditLog {
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
