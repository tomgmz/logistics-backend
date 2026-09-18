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

/**
 * The successor's details, plus why the handover is happening.
 *
 * There is no outgoing id: the system permits exactly one active IT Admin, so the
 * account being replaced is looked up rather than named by the caller — which
 * also means a stale id in a form cannot retire the wrong person.
 */
export interface TransitionITAdminInput {
  first_name:   string
  last_name:    string
  middle_name?: string | null
  suffix?:      string | null
  email:        string
  phone?:       string
  // Free text, kept in the audit log. A privileged account changing hands should
  // say why on the record.
  reason:       string
}

export interface UpdateITAdminInput {
  first_name?:  string
  last_name?:   string
  middle_name?: string | null
  suffix?:      string | null
  email?:       string
  phone?:       string
}