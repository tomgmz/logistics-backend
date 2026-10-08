import { z } from 'zod'

// A booking can be crewed two ways:
//  - company path: pick a registered driver + truck (driver_id + truck_id)
//  - vendor path:  pick a registered VENDOR driver (vendor_driver_user_id) and
//    type the vendor's vehicle. The server copies the driver's details and their
//    vendor onto the delivery snapshot; no fleet record is referenced for the
//    vehicle, because vendor vehicles are never registered.
export const assignBookingSchema = z.object({
  driver_id: z.string().uuid('driver_id must be a valid UUID').optional(),
  truck_id:  z.string().uuid('truck_id must be a valid UUID').optional(),

  is_vendor_supplied:    z.boolean().optional().default(false),
  vendor_driver_user_id: z.string().uuid('Choose a vendor driver').optional(),
  vendor_vehicle_plate:  z.string().trim().max(30).optional(),
  vendor_vehicle_type:   z.string().trim().max(60).optional(),

  // Optional second driver, from the same kind of pool as the main one. null
  // (or absent) means none; sending null on a re-assign removes them.
  second_driver_id:             z.string().uuid('second_driver_id must be a valid UUID').nullable().optional(),
  second_vendor_driver_user_id: z.string().uuid('Choose a valid second vendor driver').nullable().optional(),

  // Optional helper on a route of 30 km or less, by name only — information,
  // not a crew member. The distance rule itself is applied by the service.
  helper_name: z.string().trim().max(120, 'Helper name is too long').nullable().optional(),
}).superRefine((data, ctx) => {
  if (data.is_vendor_supplied) {
    if (!data.vendor_driver_user_id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['vendor_driver_user_id'],
        message: 'Choose the vendor driver for a vendor-supplied assignment' })
    }
    if (!data.vendor_vehicle_plate) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['vendor_vehicle_plate'],
        message: 'Vehicle plate is required for a vendor-supplied assignment' })
    }
    if (data.second_driver_id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['second_driver_id'],
        message: 'A vendor-supplied delivery takes a vendor driver as the second driver' })
    }
    if (data.second_vendor_driver_user_id && data.second_vendor_driver_user_id === data.vendor_driver_user_id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['second_vendor_driver_user_id'],
        message: 'The second driver must be a different person from the main driver' })
    }
  } else {
    if (data.second_vendor_driver_user_id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['second_vendor_driver_user_id'],
        message: 'A company delivery takes a company driver as the second driver' })
    }
    if (data.second_driver_id && data.second_driver_id === data.driver_id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['second_driver_id'],
        message: 'The second driver must be a different person from the main driver' })
    }
    if (data.vendor_driver_user_id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['vendor_driver_user_id'],
        message: 'A vendor driver only applies to a vendor-supplied assignment' })
    }
    if (!data.driver_id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['driver_id'],
        message: 'driver_id is required' })
    }
    if (!data.truck_id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['truck_id'],
        message: 'truck_id is required' })
    }
  }
})

export const updateDeliveryStatusSchema = z.object({
  status: z.enum(['pending', 'in_transit', 'delivered', 'failed']),
  pickup_time:   z.string().datetime().optional(),
  delivery_time: z.string().datetime().optional(),
})

export type AssignBookingInput       = z.infer<typeof assignBookingSchema>
export type UpdateDeliveryStatusInput = z.infer<typeof updateDeliveryStatusSchema>