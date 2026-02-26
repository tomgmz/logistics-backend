export interface Subcontractor {
  // from users table
  user_id: string
  first_name: string
  last_name: string
  middle_initial?: string | null
  suffix?: string | null
  username: string
  email: string
  phone?: string | null
  role: 'subcontractor'
  status: 'active' | 'inactive' | 'archived'
  created_by?: string | null
  created_at?: Date
  updated_at?: Date

  // from subcontractors table
  subcontractor_id: string
  subcontractor_type: 'individual' | 'company'
  company_name?: string | null
  business_permit?: string | null
}

export interface CreateSubcontractorInput {
  // from users table
  first_name: string
  last_name: string
  middle_initial?: string | null
  suffix?: string | null
  username: string
  email: string
  password: string
  phone?: string
  created_by?: string

  // from subcontractors table
  subcontractor_type: 'individual' | 'company'
  company_name?: string
  business_permit?: string
}

export interface UpdateSubcontractorInput {
  // from users table
  first_name?: string
  last_name?: string
  middle_initial?: string | null
  suffix?: string | null
  username?: string
  email?: string
  phone?: string

  // from subcontractors table
  subcontractor_type?: 'individual' | 'company'
  company_name?: string
  business_permit?: string
}