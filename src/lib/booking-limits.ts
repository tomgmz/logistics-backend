/**
 * A booking carries between one and three drop-offs. One trip, one truck, at
 * most three unload points — the client booking wizard, the API validation and
 * the driver app's stop flow all work to this number, so it lives in one place.
 */
export const MAX_DESTINATIONS_PER_BOOKING = 3
