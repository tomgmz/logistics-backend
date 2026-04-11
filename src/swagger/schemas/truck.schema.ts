export const truckSchemas = {
  CreateTruckRequest: {
    type: 'object',
    required: ['plate_number', 'truck_type', 'capacity_tons'],
    properties: {
      plate_number:     { type: 'string', minLength: 1, maxLength: 20, example: 'ABC-1234' },
      truck_type:       { type: 'string', enum: ['truck', 'wing_van'], example: 'wing_van' },
      capacity_tons:    { type: 'number', example: 10 },
      model_id:         { type: 'string', format: 'uuid', nullable: true, example: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789' },
      owned_by:  { type: 'string', enum: ['company', 'vendor'], example: 'company' },
      vendor_id: { type: 'string', format: 'uuid', nullable: true, example: null },
      created_by:       { type: 'string', format: 'uuid', nullable: true, example: null },
    },
  },
  UpdateTruckRequest: {
    type: 'object',
    properties: {
      plate_number:     { type: 'string', minLength: 1, maxLength: 20, example: 'ABC-1234' },
      truck_type:       { type: 'string', enum: ['truck', 'wing_van'], example: 'wing_van' },
      capacity_tons:    { type: 'number', example: 10 },
      model_id:         { type: 'string', format: 'uuid', nullable: true, example: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789' },
      status:           { type: 'string', enum: ['available', 'in_use', 'under_maintenance', 'inactive'], example: 'available' },
      owned_by:  { type: 'string', enum: ['company', 'vendor'], example: 'company' },
      vendor_id: { type: 'string', format: 'uuid', nullable: true, example: null },
    },
  },
  Truck: {
    type: 'object',
    properties: {
      truck_id:         { type: 'string', format: 'uuid', example: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789' },
      plate_number:     { type: 'string', example: 'ABC-1234' },
      truck_type:       { type: 'string', enum: ['truck', 'wing_van'], example: 'wing_van' },
      capacity_tons:    { type: 'number', example: 10 },
      model_id:         { type: 'string', format: 'uuid', nullable: true, example: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789' },
      truck_model:      { nullable: true, allOf: [{ $ref: '#/components/schemas/TruckModel' }] },
      status:           { type: 'string', enum: ['available', 'in_use', 'under_maintenance', 'inactive', 'archived'], example: 'available' },
      owned_by:  { type: 'string', enum: ['company', 'vendor'], example: 'company' },
      vendor_id: { type: 'string', format: 'uuid', nullable: true, example: null },
      created_at:       { type: 'string', format: 'date-time', example: '2026-02-27T08:00:00.000000' },
      updated_at:       { type: 'string', format: 'date-time', example: '2026-02-27T08:00:00.000000' },
    },
  },
}