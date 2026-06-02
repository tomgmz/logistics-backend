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
  origin:                    DirectionsWaypoint
  destination:               DirectionsWaypoint
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

export type RouteLabel =
  | 'DEFAULT_ROUTE'
  | 'DEFAULT_ROUTE_ALTERNATE'
  | 'FUEL_EFFICIENT'
  | 'SHORTER_DISTANCE'

export interface DirectionsRoute {
  polyline: {
    encodedPolyline: string
    _snappedCoords?: Array<{ latitude: number; longitude: number }>
  }
  duration:       string
  staticDuration: string
  distanceMeters: number
  description?:    string
  routeLabels?:    RouteLabel[]
  routeToken?:     string
  legs:           DirectionsLeg[]
  travelAdvisory?: {
    speedReadingIntervals?: Array<{
      startPolylinePointIndex?: number
      endPolylinePointIndex?:   number
      speed?:                   string
    }>
  }
}

export interface ComputeDirectionsResponse {
  routes: DirectionsRoute[]
}

export interface DirectionsResult {
  routes: DirectionsRoute[]
}