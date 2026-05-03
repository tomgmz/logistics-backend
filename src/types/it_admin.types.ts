export interface ITAdmin {
  user_id:         string
  first_name:      string
  last_name:       string
  middle_name?: string | null
  suffix?:         string | null
  username:        string
  email:           string
  phone?:          string | null
  role:            'it_admin'
  status:          'active' | 'inactive' | 'archived' | 'permanently_locked'
  created_by?:     string | null
  created_at?:     Date
  updated_at?:     Date
}

export interface CreateITAdminInput {
  first_name:      string
  last_name:       string
  middle_name?: string | null
  suffix?:         string | null
  username:        string
  email:           string
  phone?:          string
  created_by?:     string | null
}

export interface UpdateITAdminInput {
  first_name?:     string
  last_name?:      string
  middle_name?: string | null
  suffix?:         string | null
  username?:       string
  email?:          string
  phone?:          string | null
  status?:         'active' | 'inactive' | 'archived' | 'permanently_locked'
}