export interface Admin {
  user_id:         string
  first_name:      string
  last_name:       string
  middle_initial?: string | null
  suffix?:         string | null
  username:        string
  email:           string
  phone?:          string | null
  role:            'admin' | 'super_admin'
  status:          'active' | 'inactive' | 'archived'
  created_by?:     string | null
  created_at?:     Date
  updated_at?:     Date
}

export interface CreateAdminInput {
  first_name:      string
  last_name:       string
  middle_initial?: string | null
  suffix?:         string | null
  username:        string
  email:           string
  password:        string
  phone?:          string
  role:            'admin' | 'super_admin'
  created_by?:     string | null //null for testing only
}

export interface UpdateAdminInput {
  first_name?:     string
  last_name?:      string
  middle_initial?: string | null
  suffix?:         string | null
  username?:       string
  email?:          string
  phone?:          string
  role?:           'admin' | 'super_admin'
}