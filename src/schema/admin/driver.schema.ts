import { z } from 'zod'
import {
  coreCreateFields,
  coreUpdateFields,
  passwordField,
  licenseNumberField,
  licenseExpiryField,
} from './shared.schema.js'

export const createDriverSchema = z.object({
  ...coreCreateFields(),
  password:         passwordField(),
  license_number:   licenseNumberField(),
  license_expiry:   licenseExpiryField(),
  is_vendor_driver: z.boolean().optional().default(false),
  vendor_id:        z.string().uuid().optional().nullable(),
}).refine(
  data => !data.is_vendor_driver || !!data.vendor_id,
  { path: ['vendor_id'], message: 'Vendor ID is required when driver is a vendor driver' }
)

export const updateDriverSchema = z.object({
  ...coreUpdateFields(),
  password:         passwordField().optional(),
  license_number:   licenseNumberField().optional(),
  license_expiry:   licenseExpiryField().optional(),
  is_vendor_driver: z.boolean().optional(),
  vendor_id:        z.string().uuid().optional().nullable(),
}).refine(
  data => {
    if (data.is_vendor_driver === true) return !!data.vendor_id
    return true
  },
  { path: ['vendor_id'], message: 'Vendor ID is required when driver is a vendor driver' }
)