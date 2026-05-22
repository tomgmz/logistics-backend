import { z } from 'zod'
import {
  coreCreateFields,
  coreUpdateFields,
  licenseNumberField,
  licenseExpiryField,
} from './shared.schema.js'
const coercedBoolean = z.preprocess(
  v => v === 'true' ? true : v === 'false' ? false : v,
  z.boolean(),
)

const coercedUuid = z.preprocess(
  v => (v === 'null' || v === '' ? null : v),
  z.string().uuid().optional().nullable(),
)

export const createDriverSchema = z.object({
  ...coreCreateFields(),
  license_number:    licenseNumberField(),
  license_expiry:    licenseExpiryField(),
  license_image_url: z.string().url().optional().nullable(),
  is_vendor_driver:  coercedBoolean.optional().default(false),
  vendor_id:         coercedUuid,
}).refine(
  data => !data.is_vendor_driver || !!data.vendor_id,
  { path: ['vendor_id'], message: 'Vendor ID is required when driver is a vendor driver' }
)

export const updateDriverSchema = z.object({
  ...coreUpdateFields(),
  license_number:    licenseNumberField().optional(),
  license_expiry:    licenseExpiryField().optional(),
  license_image_url: z.string().url().optional().nullable(),
  is_vendor_driver:  coercedBoolean.optional(),
  vendor_id:         coercedUuid,
}).refine(
  data => {
    if (data.is_vendor_driver === true) return !!data.vendor_id
    return true
  },
  { path: ['vendor_id'], message: 'Vendor ID is required when driver is a vendor driver' }
)