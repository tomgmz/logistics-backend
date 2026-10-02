-- The client no longer picks a vehicle when booking: the Operations Manager
-- chooses the vehicle (and driver) at assignment, and the assignment writes the
-- vehicle's model name here. Until then a booking has no vehicle type.
ALTER TABLE bookings ALTER COLUMN truck_type_needed DROP NOT NULL;
