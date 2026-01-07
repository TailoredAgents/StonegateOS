'use client';

import { useEffect } from "react";
import * as Leaflet from "leaflet";
import { Circle, CircleMarker, MapContainer, TileLayer, useMap, ZoomControl } from "react-leaflet";
import { cn } from "@myst-os/ui";

const WOODSTOCK_CITY_CENTER: [number, number] = [34.1014112, -84.5192192];
const SERVICE_RADIUS_METERS = 20 * 1609.344;

function FitServiceRadiusBounds({ center, radiusMeters }: { center: [number, number]; radiusMeters: number }) {
  const map = useMap();

  useEffect(() => {
    const bounds = Leaflet.latLng(center).toBounds(radiusMeters);
    map.fitBounds(bounds, { padding: [24, 24] });
  }, [center, map, radiusMeters]);

  return null;
}

export function ServiceAreaMap({ className }: { className?: string }) {
  return (
    <div className={cn("relative h-[420px] w-full overflow-hidden rounded-3xl border border-neutral-200 bg-white", className)}>
      <MapContainer
        center={WOODSTOCK_CITY_CENTER}
        zoom={10}
        scrollWheelZoom={false}
        zoomControl={false}
        className="h-full w-full"
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
          url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
        />
        <FitServiceRadiusBounds center={WOODSTOCK_CITY_CENTER} radiusMeters={SERVICE_RADIUS_METERS} />
        <Circle
          center={WOODSTOCK_CITY_CENTER}
          radius={SERVICE_RADIUS_METERS}
          pathOptions={{ color: "#dc2626", weight: 3, fillColor: "#dc2626", fillOpacity: 0.18 }}
        />
        <CircleMarker
          center={WOODSTOCK_CITY_CENTER}
          radius={6}
          pathOptions={{ color: "#b91c1c", weight: 2, fillColor: "#ef4444", fillOpacity: 0.95 }}
        />
        <ZoomControl position="bottomright" />
      </MapContainer>
      <div className="pointer-events-none absolute left-4 top-4 z-[400] max-w-[260px] rounded-2xl bg-white/90 px-4 py-3 shadow-soft ring-1 ring-black/5 backdrop-blur">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-neutral-600">Service radius</p>
        <p className="mt-1 text-sm text-neutral-700">30-mile coverage area from Woodstock, GA</p>
      </div>
    </div>
  );
}
