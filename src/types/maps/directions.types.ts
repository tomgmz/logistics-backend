export interface LatLng {
  latitude: number
  longitude: number
}

export interface DirectionsWaypoint {
  location: {
    latLng: LatLng
  }
  sideOfRoad?: boolean
}

export type TravelMode = 'DRIVE' | 'WALK' | 'BICYCLE' | 'TRANSIT' | 'TWO_WHEELER'

export type RoutingPreference =
  | 'ROUTING_PREFERENCE_UNSPECIFIED'
  | 'TRAFFIC_UNAWARE'
  | 'TRAFFIC_AWARE'
  | 'TRAFFIC_AWARE_OPTIMAL'

export interface RouteModifiers {
  avoidTolls?:    boolean
  avoidHighways?: boolean
  avoidFerries?:  boolean
}

export interface ComputeDirectionsRequest {
  origin:      DirectionsWaypoint
  destination: DirectionsWaypoint
  intermediates?:            DirectionsWaypoint[]
  travelMode?:               TravelMode
  routingPreference?:        RoutingPreference
  routeModifiers?:           RouteModifiers
  departureTime?:            string
  computeAlternativeRoutes?: boolean
  languageCode?:             string
  units?:                    'METRIC' | 'IMPERIAL'
}

export interface DirectionsLeg {
  duration: string
}

export interface DirectionsRoute {
  polyline: {
    encodedPolyline: string
  }
  duration: string
  legs:     DirectionsLeg[]
}

export interface ComputeDirectionsResponse {
  routes: DirectionsRoute[]
}

export interface DirectionsResult {
  routes: DirectionsRoute[]
}