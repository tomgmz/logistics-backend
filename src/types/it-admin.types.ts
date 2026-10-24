export interface ITAdmin {
  user_id:     string
  first_name:  string | null
  last_name:   string | null
  middle_name?: string | null
  suffix?:     string | null
  email:       string
  phone?:      string | null
  role:        'it_admin'
  status:      'active' | 'inactive' | 'archived'
  created_by?: string | null
  created_at?: Date
  updated_at?: Date
}

export interface CreateITAdminInput {
  first_name:  string
  last_name:   string
  middle_name?: string | null
  suffix?:     string | null
  email:       string
  phone?:      string
  created_by?: string
}

/** One row of it_admin_handovers. */
export interface ITAdminHandover {
  handover_id:        string
  outgoing_id:        string
  reason:             string
  started_at:         string
  render_due_at:      string
  successor_id:       string | null
  successor_added_at: string | null
  confirmed_at:       string | null
  ended_at:           string | null
  cancelled_at:       string | null
  created_by:         string | null
}

/** The successor's details (added at the start of a handover or later). */
export interface ITAdminSuccessorInput {
  first_name:   string
  last_name:    string
  middle_name?: string | null
  suffix?:      string | null
  email:        string
  phone?:       string
}

/** Starting a handover: why, and the successor if one is already known. */
export interface StartHandoverInput {
  reason:     string
  successor?: ITAdminSuccessorInput | null
}

export interface UpdateITAdminInput {
  first_name?:  string
  last_name?:   string
  middle_name?: string | null
  suffix?:      string | null
  email?:       string
  phone?:       string
}