/**
 * How a booking's cargo is shared between its trips — the pure part.
 *
 * Operations plans "10 of the 20 cartons on trip 1, the other 10 on trip 2"; the
 * driver can load more or less than that at the pickup. Whatever they load, the
 * rest of the cargo still has to go, so the trips AFTER the one being loaded are
 * reshaped to carry exactly what is left:
 *
 *   * loaded less  → the shortfall goes on the next trip (a stop is added there
 *                    if that trip didn't serve the drop-off, a new trip at the end
 *                    if there is no next trip);
 *   * loaded more  → the extra comes off the LAST trips first, so a trip that
 *                    drops to nothing is always the last one and nothing is
 *                    renumbered (the phone addresses trips by number offline).
 *
 * No I/O here: trip.service reads the plan, calls `rollCargo`, and writes the
 * difference. The driver app runs the same rules on its cached plan so the next
 * trip's route is right before the pickup has synced.
 */

export interface CargoLine {
  item_id:        string
  destination_id: string
  /** The booked quantity; a line with none is one indivisible unit. */
  total:          number
}

export interface PlanCargo {
  item_id:     string
  planned_qty: number
  loaded_qty:  number | null
}

export interface PlanStop {
  destination_id: string
  cargo:          PlanCargo[]
}

export interface PlanTrip {
  trip_number: number
  /** 'in_transit' | 'completed' trips are history and never reshaped. */
  started:     boolean
  stops:       PlanStop[]
}

const EPS = 1e-9

export const lineTotal = (quantity: number | null | undefined): number =>
  typeof quantity === 'number' && quantity > 0 ? quantity : 1

/** What a started trip took of a line: what was loaded, else what was planned. */
function takenOn(trip: PlanTrip, itemId: string): number {
  let sum = 0
  for (const s of trip.stops) for (const c of s.cargo) {
    if (c.item_id === itemId) sum += c.loaded_qty ?? c.planned_qty
  }
  return sum
}

function plannedOn(trip: PlanTrip, itemId: string): number {
  let sum = 0
  for (const s of trip.stops) for (const c of s.cargo) if (c.item_id === itemId) sum += c.planned_qty
  return sum
}

/** Set one line's planned quantity on a trip, adding or removing its stop/row as needed. */
function setPlanned(trip: PlanTrip, line: CargoLine, qty: number): void {
  let stop = trip.stops.find((s) => s.destination_id === line.destination_id)
  if (!stop) {
    if (qty <= EPS) return
    stop = { destination_id: line.destination_id, cargo: [] }
    trip.stops.push(stop)
  }
  const row = stop.cargo.find((c) => c.item_id === line.item_id)
  if (qty <= EPS) {
    stop.cargo = stop.cargo.filter((c) => c.item_id !== line.item_id)
  } else if (row) {
    row.planned_qty = qty
  } else {
    stop.cargo.push({ item_id: line.item_id, planned_qty: qty, loaded_qty: null })
  }
}

export class CargoLoadError extends Error {}

/**
 * Load trip `tripNumber` with `loaded` (item → quantity; items not named load as
 * planned) and reshape the later trips to carry the rest. Returns the new plan;
 * the input is not modified.
 *
 * Throws CargoLoadError when the driver claims more than is left of a line, or
 * loads nothing at all.
 */
export function rollCargo(
  plan:       PlanTrip[],
  lines:      CargoLine[],
  tripNumber: number,
  loaded:     Map<string, number>,
): PlanTrip[] {
  const trips = plan
    .map((t) => ({ ...t, stops: t.stops.map((s) => ({ ...s, cargo: s.cargo.map((c) => ({ ...c })) })) }))
    .sort((a, b) => a.trip_number - b.trip_number)
  const trip = trips.find((t) => t.trip_number === tripNumber)
  if (!trip) throw new CargoLoadError(`Trip ${tripNumber} is not on this booking`)

  const earlier = trips.filter((t) => t.started && t.trip_number !== tripNumber)
  const later   = trips.filter((t) => !t.started && t.trip_number > tripNumber)

  for (const line of lines) {
    const remaining = line.total - earlier.reduce((n, t) => n + takenOn(t, line.item_id), 0)
    const take      = loaded.has(line.item_id) ? loaded.get(line.item_id)! : plannedOn(trip, line.item_id)

    if (take < -EPS) throw new CargoLoadError('A loaded quantity cannot be negative')
    if (take > remaining + EPS) {
      throw new CargoLoadError(
        `Cannot load ${take} of a cargo line that has only ${Math.max(0, remaining)} left to deliver`,
      )
    }

    setPlanned(trip, line, take)
    const row = trip.stops.find((s) => s.destination_id === line.destination_id)
      ?.cargo.find((c) => c.item_id === line.item_id)
    if (row) row.loaded_qty = take

    // What the later trips must now carry between them.
    let diff = (remaining - take) - later.reduce((n, t) => n + plannedOn(t, line.item_id), 0)
    if (diff > EPS) {
      // Short: the next trip takes it, or a new one at the end.
      let next = later[0]
      if (!next) {
        next = { trip_number: Math.max(...trips.map((t) => t.trip_number)) + 1, started: false, stops: [] }
        trips.push(next)
        later.push(next)
      }
      setPlanned(next, line, plannedOn(next, line.item_id) + diff)
    } else if (diff < -EPS) {
      // Over: take it back from the last trips first.
      for (const t of [...later].reverse()) {
        if (diff >= -EPS) break
        const have = plannedOn(t, line.item_id)
        const cut  = Math.min(have, -diff)
        setPlanned(t, line, have - cut)
        diff += cut
      }
    }
  }

  for (const t of trips) if (!t.started) t.stops = t.stops.filter((s) => s.cargo.length > 0)
  if (trip.stops.length === 0) throw new CargoLoadError('Load at least one item for this trip')

  // Trips left with nothing to carry go. Only ever the last ones (see above).
  return trips.filter((t) => t.started || t === trip || t.stops.length > 0)
}

/**
 * Check a planner save: over every trip, each line adds up to its booked
 * quantity (started trips count what they took), a line with no booked quantity
 * goes whole on one trip, and every stop carries something. Returns the first
 * problem as a sentence, or null.
 */
export function checkPlanQuantities(
  started: PlanTrip[],
  fresh:   Array<{ trip_number: number; stops: Array<{ destination_id: string; items: Array<{ item_id: string; quantity: number }> }> }>,
  lines:   CargoLine[],
  labels:  Map<string, string>,
  rawQty:  Map<string, number | null>,
): string | null {
  const byId = new Map(lines.map((l) => [l.item_id, l]))
  const sum  = new Map<string, number>()

  for (const t of started) for (const l of lines) {
    sum.set(l.item_id, (sum.get(l.item_id) ?? 0) + takenOn(t, l.item_id))
  }

  for (const t of fresh) {
    const seen = new Set<string>()
    for (const st of t.stops) {
      const items = st.items.filter((i) => i.quantity > 0)
      const destinationHasCargo = lines.some((l) => l.destination_id === st.destination_id)
      if (items.length === 0 && destinationHasCargo) {
        return `Trip ${t.trip_number} stops at a drop-off without carrying anything for it`
      }
      for (const it of items) {
        const line = byId.get(it.item_id)
        if (!line) return `A cargo line on trip ${t.trip_number} is not on this booking`
        if (line.destination_id !== st.destination_id) {
          return `${labels.get(it.item_id) ?? 'A cargo line'} is planned onto the wrong drop-off on trip ${t.trip_number}`
        }
        if (seen.has(it.item_id)) return `${labels.get(it.item_id) ?? 'A cargo line'} appears twice on trip ${t.trip_number}`
        seen.add(it.item_id)
        if (rawQty.get(it.item_id) == null && Math.abs(it.quantity - 1) > EPS) {
          return `${labels.get(it.item_id) ?? 'A cargo line'} has no quantity and cannot be split across trips`
        }
        sum.set(it.item_id, (sum.get(it.item_id) ?? 0) + it.quantity)
      }
    }
  }

  for (const l of lines) {
    const got = sum.get(l.item_id) ?? 0
    if (Math.abs(got - l.total) > EPS) {
      const what = labels.get(l.item_id) ?? 'A cargo line'
      return got < l.total
        ? `${what}: ${round(l.total - got)} of ${round(l.total)} are not on any trip`
        : `${what}: ${round(got - l.total)} more than the ${round(l.total)} booked are planned`
    }
  }
  return null
}

const round = (n: number) => Math.round(n * 1000) / 1000
