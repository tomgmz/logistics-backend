
export interface HandlingCode {
  handling_code_id: string
  code:             string
  name:             string
  description?:     string | null
  type:             'standard' | 'additional'
  is_active:        boolean
  created_at?:      Date
}

export interface CreateHandlingCodeInput {
  code:         string
  name:         string
  description?: string
  type?:        'standard' | 'additional'
  is_active?:   boolean
}

export interface UpdateHandlingCodeInput {
  code?:        string
  name?:        string
  description?: string | null
  type?:        'standard' | 'additional'
  is_active?:   boolean
}

export interface Commodity {
  commodity_id: string
  name:         string
  description?: string | null
  category?:    string | null
  is_active:    boolean
  created_at?:  Date
}

export interface CreateCommodityInput {
  name:         string
  description?: string
  category?:    string
  is_active?:   boolean
}

export interface UpdateCommodityInput {
  name?:        string
  description?: string | null
  category?:    string | null
  is_active?:   boolean
}

export interface Product {
  product_id:    string
  commodity_id:  string 
  name:          string
  description?:  string | null
  unit?:         string | null
  is_active:     boolean
  created_at?:   Date
  // joined
  commodities?: { name: string; category?: string | null } | null
}

export interface CreateProductInput {
  commodity_id:  string
  name:          string
  description?:  string
  unit?:         string
  is_active?:    boolean
}

export interface UpdateProductInput {
  commodity_id?: string
  name?:         string
  description?:  string | null
  unit?:         string | null
  is_active?:    boolean
}

export interface BookingCargoItemFields {
  // catalog picks (FK)
  commodity_id?:   string | null
  product_id?:     string | null
  shc_id?:         string | null
  ashc_id?:        string | null
  // free-text fallbacks (mutually exclusive with their FK counterpart)
  commodity_text?: string | null
  product_text?:   string | null
  shc_text?:       string | null
  ashc_text?:      string | null
}