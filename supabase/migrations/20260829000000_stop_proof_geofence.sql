-- Where the driver actually was when they confirmed a stop.
--
-- A proof photo says the load was there; it says nothing about where "there"
-- was. These columns record the position the app captured at the moment the
-- driver confirmed, so a stop marked done from across town is visible after the
-- fact rather than indistinguishable from one marked done at the gate.
--
-- `proof_distance_m` is the computed distance from the stop's own coordinates,
-- stored rather than recomputed so the record stands even if the booking's
-- address is later corrected. `proof_override_reason` is null for a confirmation
-- that passed the distance gate, and carries the driver's stated reason when
-- they forced one through — GPS is dead inside most warehouse docks, and a
-- driver who cannot confirm will get the stop marked some other way, off the
-- record. An override keeps it on the record.

alter table booking_destinations
  add column if not exists proof_latitude        numeric,
  add column if not exists proof_longitude       numeric,
  add column if not exists proof_accuracy_m      numeric,
  add column if not exists proof_distance_m      numeric,
  add column if not exists proof_override_reason text;

alter table bookings
  add column if not exists pickup_proof_latitude        numeric,
  add column if not exists pickup_proof_longitude       numeric,
  add column if not exists pickup_proof_accuracy_m      numeric,
  add column if not exists pickup_proof_distance_m      numeric,
  add column if not exists pickup_proof_override_reason text;

-- Operations reviews forced confirmations; both are rare by design, so a
-- partial index keeps them cheap to find without carrying the common case.
create index if not exists idx_booking_destinations_proof_override
  on booking_destinations (destination_id)
  where proof_override_reason is not null;

create index if not exists idx_bookings_pickup_proof_override
  on bookings (booking_id)
  where pickup_proof_override_reason is not null;

comment on column booking_destinations.proof_distance_m is
  'Metres between the driver''s captured position and this drop-off when they confirmed it.';
comment on column booking_destinations.proof_override_reason is
  'Null when the confirmation was inside the geofence; the driver''s stated reason when forced through.';
comment on column bookings.pickup_proof_distance_m is
  'Metres between the driver''s captured position and the origin when they confirmed pickup.';
comment on column bookings.pickup_proof_override_reason is
  'Null when the confirmation was inside the geofence; the driver''s stated reason when forced through.';
