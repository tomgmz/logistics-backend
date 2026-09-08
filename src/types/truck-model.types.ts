export interface TruckModel {
  model_id:           string
  name:               string
  vehicle_type:       string
  dimension_mm?:      string | null
  // Cargo bed dimensions. The client wizard counts pallet floor positions from
  // these, so they travel with every truck model read.
  length_mm?:         number | null
  width_mm?:          number | null
  height_mm?:         number | null
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
  vehicle_type:       string
  dimension_mm?:      string | null
  suitable_for?:      string | null
  stackable_friendly?: boolean
  max_volume_cbm?:    number | null
  max_weight_kg?:     number | null
  max_length_cm?:     number | null
  image_url:          string
}

export interface UpdateTruckModelInput {
  name?:              string
  vehicle_type?:      string
  dimension_mm?:      string | null
  suitable_for?:      string | null
  stackable_friendly?: boolean
  max_volume_cbm?:    number | null
  max_weight_kg?:     number | null
  max_length_cm?:     number | null
  image_url?:         string
}