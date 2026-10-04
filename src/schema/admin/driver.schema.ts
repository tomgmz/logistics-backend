import { z } from 'zod'
import {
  coreCreateFields,
  coreUpdateFields,
  licenseNumberField,
  licenseExpiryField,
} from './shared.schema.js'

// The form posts multipart (the license photo rides along), so a boolean
// arrives as the string "true" / "false".
const multipartBoolean = () =>
  z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean())

const vendorNameField    = () => z.string().trim().min(1, 'Vendor name is required').max(120)
const vendorContactField = () => z.string().trim().max(120)

// One form, two kinds of driver:
//  - company (8338) driver: a staff account that signs in with OTP or password
//  - vendor driver: is_external, signs in with a passkey, and carries the vendor
//    it comes from so Booking Management can copy it onto the delivery.
export const createDriverSchema = z.object({
  ...coreCreateFields(),
  license_number:    licenseNumberField(),
  license_expiry:    licenseExpiryField(),
  license_image_url: z.string().url().optional().nullable(),

  is_external:       multipartBoolean().optional().default(false),
  vendor_name:       vendorNameField().optional(),
  vendor_contact:    vendorContactField().optional(),
}).superRefine((data, ctx) => {
  if (data.is_external && !data.vendor_name) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['vendor_name'],
      message: 'Vendor name is required for a vendor driver' })
  }
  // A company driver has no vendor; accepting one and storing it would make the
  // driver look vendor-supplied wherever the field is shown.
  if (!data.is_external && (data.vendor_name || data.vendor_contact)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['vendor_name'],
      message: 'Vendor details only apply to a vendor driver' })
  }
})

// is_external is deliberately absent: a driver never switches between company
// and vendor. The service only writes the vendor fields on a vendor driver.
export const updateDriverSchema = z.object({
  ...coreUpdateFields(),
  license_number:    licenseNumberField().optional(),
  license_expiry:    licenseExpiryField().optional(),
  license_image_url: z.string().url().optional().nullable(),
  vendor_name:       vendorNameField().optional(),
  vendor_contact:    vendorContactField().optional().nullable(),
})
