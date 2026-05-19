export interface Admin {
  user_id:         string
  first_name:      string
  last_name:       string
  middle_name?: string | null
  suffix?:         string | null
  email:           string
  phone?:          string | null
  role:            'admin'
  status:          'active' | 'inactive' | 'archived'
  created_by?:     string | null
  created_at?:     Date
  updated_at?:     Date
}

export interface CreateAdminInput {
  first_name:      string
  last_name:       string
  middle_name?: string | null
  suffix?:         string | null
  email:           string
  phone?:          string
  role:            'admin'
  created_by?:     string
}

export interface UpdateAdminInput {
  first_name?:     string
  last_name?:      string
  middle_name?: string | null
  suffix?:         string | null
  email?:          string
  phone?:          string
  role?:           'admin'
}