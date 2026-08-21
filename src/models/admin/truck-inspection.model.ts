import { supabase } from '../../lib/supabase.js'
import type { BlowbagetsItems } from '../../types/client/booking.types.js'

/**
 * BLOWBAGETS inspections recorded against a VEHICLE (not a booking). History is
 * append-only; the newest row per truck is the one that decides whether
 * operations may pick that vehicle.
 */

export interface TruckInspection {
  inspection_id: string
  truck_id:      string
  items:         BlowbagetsItems
  passed:        boolean
  notes:         string | null
  inspected_by:  string | null
  inspected_at:  string
  created_at:    string
  // joined
  inspector?: { first_name: string; last_name: string } | null
}

const SELECT = `
  inspection_id,
  truck_id,
  items,
  passed,
  notes,
  inspected_by,
  inspected_at,
  created_at,
  inspector:users!truck_inspections_inspected_by_fkey ( first_name, last_name )
`

export async function create(input: {
  truck_id:     string
  items:        BlowbagetsItems
  passed:       boolean
  notes?:       string | null
  inspected_by: string | null
}): Promise<TruckInspection> {
  const { data, error } = await supabase
    .from('truck_inspections')
    .insert({
      truck_id:     input.truck_id,
      items:        input.items,
      passed:       input.passed,
      notes:        input.notes ?? null,
      inspected_by: input.inspected_by,
      inspected_at: new Date().toISOString(),
    })
    .select(SELECT)
    .single()

  if (error) throw error
  return data as unknown as TruckInspection
}

/** Full inspection history for one vehicle, newest first. */
export async function listForTruck(truckId: string, limit = 20): Promise<TruckInspection[]> {
  const { data, error } = await supabase
    .from('truck_inspections')
    .select(SELECT)
    .eq('truck_id', truckId)
    .order('inspected_at', { ascending: false })
    .limit(limit)

  if (error) throw error
  return (data ?? []) as unknown as TruckInspection[]
}

/**
 * The latest inspection for every truck that has one. Callers zip this onto a
 * truck list so the UI can show readiness without an N+1 query.
 */
export async function latestByTruck(): Promise<Map<string, TruckInspection>> {
  const { data, error } = await supabase
    .from('truck_inspections')
    .select(SELECT)
    .order('inspected_at', { ascending: false })

  if (error) throw error

  const byTruck = new Map<string, TruckInspection>()
  for (const row of (data ?? []) as unknown as TruckInspection[]) {
    if (!byTruck.has(row.truck_id)) byTruck.set(row.truck_id, row)
  }
  return byTruck
}
