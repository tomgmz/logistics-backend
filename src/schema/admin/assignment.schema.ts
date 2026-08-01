import { z } from 'zod'

// A booking can be crewed two ways:
//  - company path: pick a registered driver + truck (driver_id + truck_id)
//  - vendor path:  type the vendor / driver / vehicle details ad-hoc; they are
//    snapshotted onto the delivery and no fleet record is referenced.
export const assignBookingSchema = z.object({
  driver_id: z.string().uuid('driver_id must be a valid UUID').optional(),
  truck_id:  z.string().uuid('truck_id must be a valid UUID').optional(),

  is_vendor_supplied:    z.boolean().optional().default(false),
  vendor_name:           z.string().trim().max(120).optional(),
  vendor_contact:        z.string().trim().max(120).optional(),
  vendor_driver_name:    z.string().trim().max(120).optional(),
  vendor_driver_license: z.string().trim().max(60).optional(),
  vendor_driver_phone:   z.string().trim().max(30).optional(),
  vendor_vehicle_plate:  z.string().trim().max(30).optional(),
  vendor_vehicle_type:   z.string().trim().max(60).optional(),
}).superRefine((data, ctx) => {
  if (data.is_vendor_supplied) {
    if (!data.vendor_driver_name) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['vendor_driver_name'],
        message: 'Driver name is required for a vendor-supplied assignment' })
    }
    if (!data.vendor_vehicle_plate) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['vendor_vehicle_plate'],
        message: 'Vehicle plate is required for a vendor-supplied assignment' })
    }
  } else {
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
  status: z.enum(['pending', 'in_transit', 'completed', 'cancelled']),
  pickup_time:   z.string().datetime().optional(),
  delivery_time: z.string().datetime().optional(),
})

export type AssignBookingInput       = z.infer<typeof assignBookingSchema>
export type UpdateDeliveryStatusInput = z.infer<typeof updateDeliveryStatusSchema>