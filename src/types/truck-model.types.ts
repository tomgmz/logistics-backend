export interface TruckModel {
  model_id:           string
  name:               string
  body_type?:         string | null
  dimension_mm?:      string | null
  suitable_for?:      string | null
  stackable_friendly: boolean
  max_volume_cbm?:    number | null
  max_weight_kg?:     number | null
  max_length_cm?:     number | null
  image_url:          string
  created_at?:        string
}

export interface CreateTruckModelInput {
  name:               string
  body_type?:         string | null
  dimension_mm?:      string | null
  suitable_for?:      string | null
  stackable_friendly?: boolean
  max_volume_cbm?:    number | null
  max_weight_kg?:     number | null
  max_length_cm?:     number | null
  image_url:          string
}

export interface UpdateTruckModelInput {
  name?:               string
  body_type?:          string | null
  dimension_mm?:       string | null
  suitable_for?:       string | null
  stackable_friendly?: boolean
  max_volume_cbm?:     number | null
  max_weight_kg?:      number | null
  max_length_cm?:      number | null
  image_url?:          string
}