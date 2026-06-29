"use client";

import { useMemo } from "react";
import { decodePolyline } from "@/lib/strava/polyline";

/**
 * Renders a Strava activity's GPS route as a pure-SVG trace — no map tiles,
 * no external dependency. Lat/lng are projected into the viewBox with the
 * longitude axis compressed by cos(latitude) so the shape stays true.
 */
export function RouteMap({
  polyline,
  width = 68,
  height = 44,
  strokeWidth = 1.5,
  className,
}: {
  polyline: string;
  width?: number;
  height?: number;
  strokeWidth?: number;
  className?: string;
}) {
  const path = useMemo(() => {
    const pts = decodePolyline(polyline);
    if (pts.length < 2) return null;

    const lats = pts.map((p) => p[0]);
    const lngs = pts.map((p) => p[1]);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);

    // Compress longitude by cos(mean latitude) so distances read true-to-shape.
    const meanLat = (minLat + maxLat) / 2;
    const lngScale = Math.cos((meanLat * Math.PI) / 180) || 1;

    const spanX = (maxLng - minLng) * lngScale || 1e-6;
    const spanY = maxLat - minLat || 1e-6;

    const pad = strokeWidth + 1;
    const fit = Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanY);
    const offX = (width - spanX * fit) / 2;
    const offY = (height - spanY * fit) / 2;

    return pts
      .map(([lat, lng], i) => {
        const x = offX + (lng - minLng) * lngScale * fit;
        const y = offY + (maxLat - lat) * fit; // flip: north is up
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }, [polyline, width, height, strokeWidth]);

  if (!path) return null;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={className}
      aria-label="Activity route"
      role="img"
    >
      <path
        d={path}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        strokeLinecap="round"
        opacity={0.92}
      />
    </svg>
  );
}
