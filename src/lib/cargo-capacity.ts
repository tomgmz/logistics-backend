import { pool } from './database.js'

/**
 * Does this vehicle actually fit this booking's cargo?
 *
 * The booking already records everything needed to answer that — gross weight,
 * volume, the longest edge, and per-line dimensions — and until now nothing on
 * the server ever looked. The client's wizard warned about it and then the
 * figures travelled downstream as decoration: operations could crew a booking
 * with a vehicle that demonstrably cannot carry it, and the general manager
 * approving it saw the numbers with nothing comparing them to anything.
 *
 * This mirrors `lib/cargo/capacity.ts` in the web client deliberately: the two
 * must agree, or the client would clear a load the server then queries (or
 * worse, the reverse). Keep them in step.
 *
 * It WARNS. It does not refuse the assignment — operations sometimes know
 * something the data does not (a load that splits, a shipper who overstated a
 * weight), and a wrong refusal here strands a real delivery. The warning is
 * returned to the caller and written to the audit log so the decision is at
 * least on the record.
 */

/** Share of a body's geometric volume that can realistically be filled. */
export const STOWAGE_FACTOR = 0.80

export interface CapacityWarning {
  /** Human-readable reasons, most serious first. */
  reasons:         string[]
  overWeight:      boolean
  overVolume:      boolean
  overLength:      boolean
  overFloorSpace:  boolean
  usableVolumeCbm: number | null
}

interface BookingCapacityRow {
  required_weight_kg:  string | null
  required_volume_cbm: string | null
  required_length_cm:  string | null
  non_stackable_cargo: boolean | null
}

interface TruckSpecRow {
  name:               string | null
  max_weight_kg:      string | null
  max_volume_cbm:     string | null
  max_length_cm:      string | null
  length_mm:          number | null
  width_mm:           number | null
  height_mm:          number | null
  stackable_friendly: boolean | null
}

interface CargoFootprintRow {
  length_cm: string | null
  width_cm:  string | null
  height_cm: string | null
  quantity:  string | null
}

const num = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Floor positions for one item on a bed, taking the best orientation.
 *
 * An item may be turned onto another face only if the booking did not mark it
 * otherwise; the server has no per-line tilt flag, so it assumes the item may be
 * laid down — the optimistic reading, chosen so this never invents a problem the
 * client's own check did not already show the user.
 */
function floorPositions(
  bedLcm: number, bedWcm: number, bedHcm: number | null,
  l: number, w: number, h: number,
): number {
  const fit = (a: number, b: number) => Math.floor(bedLcm / a) * Math.floor(bedWcm / b)
  const orientations: Array<[number, number, number]> = [[l, w, h], [l, h, w], [w, h, l]]

  let best = 0
  for (const [a, b, up] of orientations) {
    if (bedHcm !== null && up > bedHcm) continue
    best = Math.max(best, fit(a, b), fit(b, a))
  }
  return best > 0 ? best : 0
}

/**
 * Compare a booking's recorded cargo against a truck model's specification.
 * Returns null when there is nothing to complain about, or nothing to compare.
 */
export async function checkTruckCapacity(
  bookingId: string,
  truckId:   string,
): Promise<CapacityWarning | null> {
  const [bookingRes, truckRes, cargoRes] = await Promise.all([
    pool.query<BookingCapacityRow>(
      `SELECT required_weight_kg, required_volume_cbm, required_length_cm, non_stackable_cargo
         FROM bookings WHERE booking_id = $1`,
      [bookingId],
    ),
    pool.query<TruckSpecRow>(
      `SELECT tm.name, tm.max_weight_kg, tm.max_volume_cbm, tm.max_length_cm,
              tm.length_mm, tm.width_mm, tm.height_mm, tm.stackable_friendly
         FROM trucks t
         JOIN truck_models tm ON tm.model_id = t.model_id
        WHERE t.truck_id = $1`,
      [truckId],
    ),
    pool.query<CargoFootprintRow>(
      `SELECT length_cm, width_cm, height_cm, quantity
         FROM booking_cargo_items
        WHERE booking_id = $1`,
      [bookingId],
    ),
  ])

  const booking = bookingRes.rows[0]
  const truck   = truckRes.rows[0]
  // A vehicle with no model, or a booking with no recorded requirements, gives
  // nothing to measure. Silence is correct here, not a false all-clear.
  if (!booking || !truck) return null

  const reasons: string[] = []

  const weightKg  = num(booking.required_weight_kg)
  const volumeCbm = num(booking.required_volume_cbm)
  const lengthCm  = num(booking.required_length_cm)

  const maxWeightKg  = num(truck.max_weight_kg)
  const maxVolumeCbm = num(truck.max_volume_cbm)
  const maxLengthCm  = num(truck.max_length_cm)

  const usableVolumeCbm = maxVolumeCbm !== null ? maxVolumeCbm * STOWAGE_FACTOR : null

  const overWeight = weightKg !== null && maxWeightKg !== null && weightKg > maxWeightKg
  if (overWeight) {
    reasons.push(`Load is ${weightKg} kg; ${truck.name ?? 'this vehicle'} carries ${maxWeightKg} kg.`)
  }

  const overLength = lengthCm !== null && maxLengthCm !== null && lengthCm > maxLengthCm
  if (overLength) {
    reasons.push(`Longest item is ${lengthCm} cm; the body takes ${maxLengthCm} cm.`)
  }

  const overVolume =
    volumeCbm !== null && usableVolumeCbm !== null && volumeCbm > usableVolumeCbm
  if (overVolume) {
    reasons.push(
      `Load is ${volumeCbm} CBM; usable capacity is ${usableVolumeCbm.toFixed(1)} CBM ` +
      `(${maxVolumeCbm} CBM body at ${Math.round(STOWAGE_FACTOR * 100)}% stowage).`,
    )
  }

  // Floor space, when the bed is known and the cargo carries dimensions.
  let overFloorSpace = false
  if (truck.length_mm && truck.width_mm) {
    const bedL = truck.length_mm / 10
    const bedW = truck.width_mm  / 10
    const bedH = truck.height_mm ? truck.height_mm / 10 : null

    let needed = 0
    let available = Infinity
    let measured = false

    for (const row of cargoRes.rows) {
      const l = num(row.length_cm)
      const w = num(row.width_cm)
      const h = num(row.height_cm)
      const q = num(row.quantity) ?? 0
      if (l === null || w === null || h === null || q <= 0) continue

      measured = true
      const perLayer = floorPositions(bedL, bedW, bedH, l, w, h)
      if (perLayer === 0) {
        reasons.unshift(
          `An item of ${l}x${w}x${h} cm does not fit inside the body ` +
          `(${bedL}x${bedW}${bedH ? `x${bedH}` : ''} cm) in any orientation.`,
        )
        available = 0
        needed += q
        continue
      }
      available = Math.min(available, perLayer)
      // Double-decking only where the booking did not flag non-stackable cargo
      // and the body is built for it.
      const layers = !booking.non_stackable_cargo && truck.stackable_friendly ? 2 : 1
      needed += Math.ceil(q / layers)
    }

    // "needs 8 positions, bed holds 0" adds nothing once we have already said an
    // item does not fit the body at all — that is the same fact, told worse.
    if (measured && Number.isFinite(available) && available > 0 && needed > available) {
      overFloorSpace = true
      reasons.push(`Cargo needs ${needed} floor positions; the bed holds ${available}.`)
    }
  }

  if (reasons.length === 0) return null

  return { reasons, overWeight, overVolume, overLength, overFloorSpace, usableVolumeCbm }
}
