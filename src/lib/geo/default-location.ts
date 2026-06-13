export const DEFAULT_LOCATION = {
  name: "Tarrytown, NY",
  lat: 41.0762,
  lon: -73.8587,
  timezone: "America/New_York",
};

export type GeoLocation = {
  lat: number;
  lon: number;
  name: string;
};

export function parseGeoQuery(searchParams: URLSearchParams): GeoLocation {
  const lat = parseFloat(searchParams.get("lat") ?? "");
  const lon = parseFloat(searchParams.get("lon") ?? "");
  const name = searchParams.get("name") ?? DEFAULT_LOCATION.name;
  if (!Number.isNaN(lat) && !Number.isNaN(lon)) return { lat, lon, name };
  return { lat: DEFAULT_LOCATION.lat, lon: DEFAULT_LOCATION.lon, name: DEFAULT_LOCATION.name };
}
