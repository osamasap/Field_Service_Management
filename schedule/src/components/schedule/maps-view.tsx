"use client";

import { useMemo, useEffect, useRef, useState } from "react";
import { format, parse, startOfWeek, endOfWeek, startOfMonth, endOfMonth, startOfYear, endOfYear, startOfDay, endOfDay, isWithinInterval } from "date-fns";
import { MapPin } from "lucide-react";
import { Appointment, OpenServiceOrder } from "../../pages/schedule/types";
import { fetchServiceOrdersForMap } from "../../hooks/use-appointments";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Checkbox } from "../ui/checkbox";
import { cn } from "../../lib/utils";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

interface MapsViewProps {
  appointments: Appointment[];
  selectedDate: Date;
  onAppointmentClick?: (appointment: Appointment) => void;
  statusFilter?: string;
  technicianSearch?: string;
  searchQuery?: string;
  durationFilter?: "date" | "today" | "thisWeek" | "thisMonth" | "thisYear";
}

const STATUS_COLORS: Record<string, { bg: string; border: string; dot: string; hex: string; bgHex: string; borderHex: string }> = {
  Open: { bg: "bg-blue-100", border: "border-blue-300", dot: "bg-blue-500", hex: "#3b82f6", bgHex: "#dbeafe", borderHex: "#93c5fd" },
  Scheduled: { bg: "bg-blue-100", border: "border-blue-300", dot: "bg-blue-500", hex: "#3b82f6", bgHex: "#dbeafe", borderHex: "#93c5fd" },
  Dispatched: { bg: "bg-orange-100", border: "border-orange-300", dot: "bg-orange-500", hex: "#f97316", bgHex: "#ffedd5", borderHex: "#fdba74" },
  "In Progress": { bg: "bg-orange-100", border: "border-orange-300", dot: "bg-orange-500", hex: "#f97316", bgHex: "#ffedd5", borderHex: "#fdba74" },
  Completed: { bg: "bg-green-100", border: "border-green-300", dot: "bg-green-500", hex: "#22c55e", bgHex: "#dcfce7", borderHex: "#86efac" },
  Cancelled: { bg: "bg-gray-100", border: "border-gray-300", dot: "bg-gray-400", hex: "#9ca3af", bgHex: "#f3f4f6", borderHex: "#d1d5db" },
};

// Default map view: Egypt (whole country)
const EGYPT_CENTER: [number, number] = [26.8206, 30.8025];
const EGYPT_ZOOM = 6;
// Open Service Orders are plotted in purple so they stand out from appointments
const ORDER_MARKER_COLOR = "#9333ea";

// Today's date as a local YYYY-MM-DD string (for the date inputs)
const toLocalDateString = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

// Service Order marker icon; the selected one is larger with a pulsing highlight ring
const makeOrderIcon = (highlighted: boolean) =>
  L.divIcon({
    className: "custom-marker",
    html: highlighted
      ? `<div class="order-pin-highlight" style="background-color: ${ORDER_MARKER_COLOR}; width: 30px; height: 30px; border-radius: 50%; border: 3px solid white; box-shadow: 0 0 0 4px rgba(147,51,234,0.35), 0 2px 8px rgba(0,0,0,0.4);"></div>`
      : `<div style="background-color: ${ORDER_MARKER_COLOR}; width: 20px; height: 20px; border-radius: 50%; border: 2px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.3);"></div>`,
    iconSize: highlighted ? [30, 30] : [20, 20],
    iconAnchor: highlighted ? [15, 15] : [10, 10],
  });

// Get coordinates from appointment location data
const getCoordinates = (appointment: Appointment): [number, number] | null => {
	if (appointment.location && typeof appointment.location === "object" && "lat" in appointment.location && "lng" in appointment.location) {
		const coords: [number, number] = [appointment.location.lat, appointment.location.lng];
		if (isNaN(coords[0]) || isNaN(coords[1]) || coords[0] === 0 || coords[1] === 0) {
			return null;
		}
		return coords;
	}
	return null;
};

// Parse local datetime helper function
const parseLocalDateTime = (value: string): Date => {
  try {
    const normalized = value.replace("T", " ").slice(0, 19);
    return parse(normalized, "yyyy-MM-dd HH:mm:ss", new Date());
  } catch {
    return new Date(value);
  }
};

// Fix Leaflet default icon issue
if (typeof window !== "undefined") {

  //eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (L.Icon.Default.prototype as any)._getIconUrl;
  L.Icon.Default.mergeOptions({
    iconRetinaUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png",
    iconUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png",
    shadowUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png",
  });
}

export function MapsView({
  appointments,
  selectedDate,
  onAppointmentClick,
  statusFilter = "all",
  technicianSearch = "",
  searchQuery = "",
  durationFilter = "thisWeek",
}: MapsViewProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const markersRef = useRef<L.Marker[]>([]);
  const [openOrders, setOpenOrders] = useState<OpenServiceOrder[]>([]);
  // Service Order filter: date range defaults to today, Open checked, Completed unchecked
  const [fromDate, setFromDate] = useState(() => toLocalDateString(new Date()));
  const [toDate, setToDate] = useState(() => toLocalDateString(new Date()));
  const [showOpenOrders, setShowOpenOrders] = useState(true);
  const [showCompletedOrders, setShowCompletedOrders] = useState(false);
  // Which order's pin is highlighted (from the list or from a pin click)
  const [selectedOrderName, setSelectedOrderName] = useState<string | null>(null);
  const orderMarkersRef = useRef<Map<string, L.Marker>>(new Map());
  const highlightTimerRef = useRef<number | null>(null);

  // Re-fetch Service Order pins whenever the filter changes
  useEffect(() => {
    let cancelled = false;
    if (!showOpenOrders && !showCompletedOrders) {
      setOpenOrders([]);
      return;
    }
    fetchServiceOrdersForMap(fromDate, toDate, showOpenOrders, showCompletedOrders)
      .then((orders) => {
        if (!cancelled) setOpenOrders(orders);
      })
      .catch((error) => {
        console.error("Error fetching service orders for map:", error);
      });
    return () => {
      cancelled = true;
    };
  }, [fromDate, toDate, showOpenOrders, showCompletedOrders]);

  // Clear any pending popup timer on unmount
  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) window.clearTimeout(highlightTimerRef.current);
    };
  }, []);

  // Highlight one order's pin: pan/zoom to it, open its popup, emphasize the pin
  const highlightOrder = (orderName: string) => {
    setSelectedOrderName(orderName);
    const marker = orderMarkersRef.current.get(orderName);
    const order = openOrders.find((o) => o.name === orderName);
    const map = mapInstanceRef.current;
    if (!marker || !order?.location || !map) return;
    const coords: [number, number] = [order.location.lat, order.location.lng];
    if (highlightTimerRef.current) window.clearTimeout(highlightTimerRef.current);
    map.flyTo(coords, 14, { duration: 0.8 });
    highlightTimerRef.current = window.setTimeout(() => marker.openPopup(), 850);
  };

  // Calculate date range based on duration filter or selected date
  const dateRange = useMemo(() => {
    if (!durationFilter || durationFilter === "date") {
      return {
        start: startOfDay(selectedDate),
        end: endOfDay(selectedDate),
      };
    }

    // Otherwise use duration filter
    const today = new Date();
    switch (durationFilter) {
      case "today":
        return {
          start: startOfDay(today),
          end: endOfDay(today),
        };
      case "thisWeek":
        return {
          start: startOfWeek(today, { weekStartsOn: 1 }),
          end: endOfWeek(today, { weekStartsOn: 1 }),
        };
      case "thisMonth":
        return {
          start: startOfMonth(today),
          end: endOfMonth(today),
        };
      case "thisYear":
        return {
          start: startOfYear(today),
          end: endOfYear(today),
        };
      default:
        return {
          start: startOfDay(selectedDate),
          end: endOfDay(selectedDate),
        };
    }
  }, [durationFilter, selectedDate]);

  // Filter appointments based on props
  const filteredAppointments = useMemo(() => {
    return appointments.filter((apt) => {
      // Status filter
      if (statusFilter && statusFilter !== "all" && apt.status !== statusFilter) {
        return false;
      }

      if (apt.scheduled_start_datetime || apt.posting_date) {
        const appointmentDate = apt.scheduled_start_datetime
          ? parseLocalDateTime(apt.scheduled_start_datetime)
          : new Date(apt.posting_date);

        if (!isWithinInterval(appointmentDate, { start: dateRange.start, end: dateRange.end })) {
          return false;
        }
      }

      // Technician search filter
      if (technicianSearch.trim()) {
        const query = technicianSearch.toLowerCase();
        const hasMatchingTech = apt.service_technicians?.some(
          (tech) =>
            tech.full_name?.toLowerCase().includes(query) ||
            tech.service_technician?.toLowerCase().includes(query)
        );
        if (!hasMatchingTech) return false;
      }

      // Search query filter (appointments/addresses)
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        // Handle location - can be string or object
        const locationStr = typeof apt.location === "string"
          ? apt.location
          : (apt.location && typeof apt.location === "object" && apt.location.service_area)
            ? apt.location.service_area
            : "";
        const matches =
          apt.name?.toLowerCase().includes(query) ||
          apt.service_order?.toLowerCase().includes(query) ||
          apt.customer?.toLowerCase().includes(query) ||
          apt.service_type?.toLowerCase().includes(query) ||
          apt.service_area?.toLowerCase().includes(query) ||
          locationStr.toLowerCase().includes(query);
        if (!matches) return false;
      }

      return true;
    });
  }, [appointments, statusFilter, technicianSearch, searchQuery, dateRange]);

  // Initialize map
  useEffect(() => {
    if (mapContainerRef.current && !mapInstanceRef.current) {
      // Initialize map centered on Egypt
      const map = L.map(mapContainerRef.current).setView(EGYPT_CENTER, EGYPT_ZOOM);

      // Add OpenStreetMap tiles
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19,
      }).addTo(map);

      mapInstanceRef.current = map;

      return () => {
        map.remove();
        mapInstanceRef.current = null;
      };
    }
  }, []);

  // Update markers when filtered appointments change
  useEffect(() => {
    if (!mapInstanceRef.current) return;

    const map = mapInstanceRef.current;

    // Clear existing markers
    markersRef.current.forEach((marker) => marker.remove());
    markersRef.current = [];
    orderMarkersRef.current.clear();


    // Add markers for filtered appointments
    filteredAppointments.forEach((appointment) => {
      const coordinates = getCoordinates(appointment);

      // Skip appointments without valid location data
      if (!coordinates) {
        return;
      }


      const colors = STATUS_COLORS[appointment.status] || STATUS_COLORS.Open;

      // Create custom icon with status color
      const customIcon = L.divIcon({
        className: "custom-marker",
        html: `<div style="background-color: ${colors.hex}; width: 20px; height: 20px; border-radius: 50%; border: 2px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.3);"></div>`,
        iconSize: [20, 20],
        iconAnchor: [10, 10],
      });

      const marker = L.marker(coordinates, { icon: customIcon }).addTo(map);

      // Create popup content with location name, appointment, and technicians
      const startDateTime = appointment.scheduled_start_datetime
        ? parseLocalDateTime(appointment.scheduled_start_datetime)
        : null;

      const techniciansList = appointment.service_technicians && appointment.service_technicians.length > 0
        ? appointment.service_technicians.map(t => t.full_name || t.service_technician).join(", ")
        : "No technicians assigned";

      const locationName = (typeof appointment.location === "object" && appointment.location?.service_area)
        || (typeof appointment.location === "string" ? appointment.location : null)
        || appointment.service_area
        || appointment.customer
        || "Location not specified";

      const popupContent = `
        <div style="min-width: 250px;">
          <div style="font-weight: 600; margin-bottom: 8px; font-size: 14px;">
            ${appointment.service_order || appointment.name}
          </div>
          <div style="font-size: 12px; color: #666; margin-bottom: 6px;">
            <strong>Location:</strong> ${locationName}
          </div>
          ${appointment.customer && appointment.customer !== locationName ? `<div style="font-size: 12px; color: #666; margin-bottom: 6px;"><strong>Customer:</strong> ${appointment.customer}</div>` : ""}
          ${startDateTime ? `<div style="font-size: 12px; color: #666; margin-bottom: 6px;"><strong>Date:</strong> ${format(startDateTime, "MMM d, yyyy HH:mm")}</div>` : ""}
          <div style="font-size: 12px; color: #666; margin-bottom: 8px;">
            <strong>Technicians:</strong> ${techniciansList}
          </div>
          <div style="margin-top: 8px;">
            <span style="padding: 2px 8px; border-radius: 4px; font-size: 11px; background-color: ${colors.bgHex}; border: 1px solid ${colors.borderHex};">
              ${appointment.status}
            </span>
          </div>
          <button onclick="window.dispatchEvent(new CustomEvent('openAppointment', {detail: '${appointment.name}'}))" style="margin-top: 8px; padding: 4px 12px; background: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">
            View Details
          </button>
          <a href="https://www.google.com/maps/dir/?api=1&destination=${coordinates[0]},${coordinates[1]}" target="_blank" rel="noopener noreferrer" style="display: inline-block; margin-top: 8px; margin-left: 8px; padding: 4px 12px; background: #16a34a; color: white; border-radius: 4px; font-size: 12px; text-decoration: none;">
            Navigate
          </a>
        </div>
      `;

      marker.bindPopup(popupContent);
      marker.on("click", () => {
        onAppointmentClick?.(appointment);
      });

      markersRef.current.push(marker);
    });

    // Add markers for open Service Orders (purple, distinct from appointments)
    openOrders.forEach((order) => {
      if (!order.location) return;
      const orderCoords: [number, number] = [order.location.lat, order.location.lng];
      if (isNaN(orderCoords[0]) || isNaN(orderCoords[1]) || orderCoords[0] === 0 || orderCoords[1] === 0) {
        return;
      }

      const orderMarker = L.marker(orderCoords, { icon: makeOrderIcon(order.name === selectedOrderName) }).addTo(map);

      const orderLocationName = order.service_area || order.product_location || "Location not specified";
      const orderPopupContent = `
        <div style="min-width: 250px;">
          <div style="font-weight: 600; margin-bottom: 8px; font-size: 14px;">
            ${order.name}
          </div>
          <div style="font-size: 12px; color: #666; margin-bottom: 6px;">
            <strong>Location:</strong> ${orderLocationName}
          </div>
          ${order.customer ? `<div style="font-size: 12px; color: #666; margin-bottom: 6px;"><strong>Customer:</strong> ${order.customer}</div>` : ""}
          <div style="margin-top: 8px;">
            <span style="padding: 2px 8px; border-radius: 4px; font-size: 11px; background-color: #f3e8ff; border: 1px solid #d8b4fe;">
              ${order.status}
            </span>
          </div>
          <a href="https://www.google.com/maps/dir/?api=1&destination=${orderCoords[0]},${orderCoords[1]}" target="_blank" rel="noopener noreferrer" style="display: inline-block; margin-top: 8px; padding: 4px 12px; background: #16a34a; color: white; border-radius: 4px; font-size: 12px; text-decoration: none;">
            Navigate
          </a>
        </div>
      `;

      orderMarker.bindPopup(orderPopupContent);
      orderMarker.on("click", () => highlightOrder(order.name));
      markersRef.current.push(orderMarker);
      orderMarkersRef.current.set(order.name, orderMarker);
    });

    // Fit map to show all markers (only if we have markers)
    if (markersRef.current.length > 0) {
      const group = new L.FeatureGroup(markersRef.current);
      map.fitBounds(group.getBounds().pad(0.1));
    } else {
      // No markers: keep the Egypt overview (never fall back to another region)
      map.setView(EGYPT_CENTER, EGYPT_ZOOM);
    }
  }, [filteredAppointments, openOrders, onAppointmentClick]);

  // Apply the highlight icon to the selected pin; clear the selection when
  // the order leaves the filtered list. Runs after markers are rebuilt.
  useEffect(() => {
    if (selectedOrderName && !openOrders.some((o) => o.name === selectedOrderName)) {
      setSelectedOrderName(null);
      return;
    }
    orderMarkersRef.current.forEach((marker, name) => {
      marker.setIcon(makeOrderIcon(name === selectedOrderName));
    });
  }, [selectedOrderName, openOrders]);

  useEffect(() => {
    const handleOpenAppointment = (event: CustomEvent) => {
      const appointment = filteredAppointments.find((apt) => apt.name === event.detail);
      if (appointment) {
        onAppointmentClick?.(appointment);
      }
    };

    //eslint-disable-next-line @typescript-eslint/no-explicit-any
    window.addEventListener("openAppointment" as any, handleOpenAppointment as EventListener);
    return () => {
      //eslint-disable-next-line @typescript-eslint/no-explicit-any
      window.removeEventListener("openAppointment" as any, handleOpenAppointment as EventListener);
    };
  }, [filteredAppointments, onAppointmentClick]);

  return (
    <div className="flex h-full bg-background">
      <style>{`@keyframes order-pin-pulse { 0% { box-shadow: 0 0 0 0 rgba(147, 51, 234, 0.45); } 70% { box-shadow: 0 0 0 14px rgba(147, 51, 234, 0); } 100% { box-shadow: 0 0 0 0 rgba(147, 51, 234, 0); } } .order-pin-highlight { animation: order-pin-pulse 1.6s ease-out infinite; }`}</style>
      {/* Main Map Area */}
      <div className="flex-1 flex flex-col relative">
        {/* Map Container */}
        <div className="flex-1 relative" ref={mapContainerRef}>
          {filteredAppointments.length === 0 && openOrders.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center bg-muted/20 z-10">
              <div className="text-center space-y-2">
                <MapPin className="h-12 w-12 mx-auto text-muted-foreground opacity-50" />
                <p className="text-muted-foreground">No appointments or open service orders to show</p>
              </div>
            </div>
          )}
        </div>
      </div>
      {/* Service Orders filter + results */}
      <div className="w-72 shrink-0 border-l bg-background p-4 space-y-4 overflow-y-auto">
        <div>
          <h3 className="text-sm font-semibold">Service Orders</h3>
          <p className="text-xs text-muted-foreground">
            {openOrders.length} order{openOrders.length === 1 ? "" : "s"} on the map
          </p>
        </div>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="map-from-date">From</Label>
            <Input
              id="map-from-date"
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="map-to-date">To</Label>
            <Input
              id="map-to-date"
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
            />
          </div>
          <div className="flex items-center space-x-2">
            <Checkbox
              id="map-show-open"
              checked={showOpenOrders}
              onCheckedChange={(v) => setShowOpenOrders(v === true)}
            />
            <Label htmlFor="map-show-open">Open Service Orders</Label>
          </div>
          <div className="flex items-center space-x-2">
            <Checkbox
              id="map-show-completed"
              checked={showCompletedOrders}
              onCheckedChange={(v) => setShowCompletedOrders(v === true)}
            />
            <Label htmlFor="map-show-completed">Completed Service Orders</Label>
          </div>
        </div>
        <div className="space-y-2">
          {openOrders.length === 0 ? (
            <p className="text-xs text-muted-foreground">No service orders match the filter.</p>
          ) : (
            openOrders.map((order) => (
              <button
                key={order.name}
                type="button"
                onClick={() => highlightOrder(order.name)}
                className={cn(
                  "w-full text-left rounded-md border p-3 space-y-1 hover:bg-accent transition-colors",
                  selectedOrderName === order.name
                    ? "border-purple-500 bg-purple-50 dark:bg-purple-950/40 ring-1 ring-purple-400"
                    : "border-border"
                )}
              >
                <div className="text-sm font-medium">{order.name}</div>
                {order.customer && (
                  <div className="text-xs text-muted-foreground">{order.customer}</div>
                )}
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "text-[11px] px-2 py-0.5 rounded-full",
                      order.status === "Completed"
                        ? "bg-green-100 text-green-800"
                        : "bg-purple-100 text-purple-800"
                    )}
                  >
                    {order.status}
                  </span>
                  {order.posting_date && (
                    <span className="text-[11px] text-muted-foreground">{order.posting_date}</span>
                  )}
                </div>
                {(order.service_area || order.product_location) && (
                  <div className="text-[11px] text-muted-foreground">
                    {order.service_area || order.product_location}
                  </div>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
