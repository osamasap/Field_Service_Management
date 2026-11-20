// Copyright (c) 2025, Beveren Software and contributors
// For license information, please see license.txt

frappe.ui.form.on("Service Area", {
  onload(frm) {
    // Validate existing location data
    if (frm.doc.location) {
      try {
        const loc =
          typeof frm.doc.location === "string"
            ? JSON.parse(frm.doc.location)
            : frm.doc.location;

        // Check if location is valid
        if (loc && loc.lat === 0 && loc.lng === 0) {
          // Clear invalid 0,0 coordinates
          frm.set_value("location", "");
        }
      } catch (e) {
        // Invalid JSON, clear it
        frm.set_value("location", "");
      }
    }

    // Setup autocomplete when form loads
    setTimeout(() => {
      setup_location_autocomplete(frm);
      bind_location_link(frm);
    }, 100);
  },
  refresh(frm) {
    // Setup autocomplete on refresh as well
    setup_location_autocomplete(frm);
    bind_location_link(frm);
  },
});

function setup_location_autocomplete(frm) {
  // Get the service_area field
  const field = frm.fields_dict.service_area;
  if (!field) {
    console.warn("Service Area field not found");
    return;
  }

  if (!field.$input || !field.$input.length) {
    console.warn("Service Area input element not found");
    return;
  }

  const inputEl = field.$input.get(0);
  if (!inputEl) {
    console.warn("Service Area input element is null");
    return;
  }

  // Avoid double-binding
  if (inputEl.__bev_autocomplete_bound) return;
  inputEl.__bev_autocomplete_bound = true;

  // Helper: debounce
  const debounce = (fn, wait = 300) => {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(null, args), wait);
    };
  };

  // Create Awesomplete instance (bundled with Frappe Desk)
  const awesomplete = new Awesomplete(inputEl, {
    minChars: 2,
    autoFirst: true,
    filter: () => true, // we handle filtering via remote results
  });

  // Store awesomplete instance and data on input element for persistence
  inputEl.__bev_awesomplete = awesomplete;
  inputEl.__bev_currentResults = [];
  inputEl.__bev_lastQuery = null;

  console.log("Autocomplete initialized for Service Area field");

  const searchPlaces = debounce((q) => {
    // Get instances from input element (ensures persistence across callbacks)
    const awesompleteInstance = inputEl.__bev_awesomplete;
    let currentResults = inputEl.__bev_currentResults || [];
    let lastQuery = inputEl.__bev_lastQuery;

    if (!awesompleteInstance) {
      console.warn("Awesomplete instance not found on input element");
      return;
    }

    if (!q || q.trim().length < 2) {
      awesompleteInstance.list = [];
      inputEl.__bev_lastQuery = null;
      return;
    }

    // Store the current query to identify stale responses
    const queryId = q.trim();
    inputEl.__bev_lastQuery = queryId;

    console.log("Searching for:", queryId);

    // Use backend API to avoid connection/CORS issues
    frappe.call({
      method:
        "beveren_fsm.field_service_management.api.geocoding.search_places",
      args: {
        query: q,
        limit: 7,
      },
      callback: (r) => {
        // Get instances from input element (ensures persistence)
        const awesompleteInstance = inputEl.__bev_awesomplete;
        const lastQuery = inputEl.__bev_lastQuery;

        if (!awesompleteInstance) {
          console.warn("Awesomplete instance not found in callback");
          return;
        }

        console.log("API Response:", r);
        // Only process if this is still the latest query (ignore stale responses)
        if (lastQuery === queryId) {
          if (r && r.message && Array.isArray(r.message)) {
            const results = r.message || [];
            inputEl.__bev_currentResults = results;
            // Safely map results and update autocomplete
            const autocompleteList = results
              .map((result) => result.label || result.value || "")
              .filter(Boolean); // Remove empty strings
            awesompleteInstance.list = autocompleteList;
            console.log(
              "Updated autocomplete with",
              autocompleteList ? autocompleteList.length : 0,
              "items"
            );
          } else {
            console.warn("Invalid response format:", r);
            inputEl.__bev_currentResults = [];
            awesompleteInstance.list = [];
          }
        } else {
          console.log("Ignoring stale response for:", queryId);
        }
      },
      error: (err) => {
        // Get instances from input element (ensures persistence)
        const awesompleteInstance = inputEl.__bev_awesomplete;
        const lastQuery = inputEl.__bev_lastQuery;

        console.error("API Error:", err);
        // Only clear if this was the latest query
        if (lastQuery === queryId && awesompleteInstance) {
          inputEl.__bev_currentResults = [];
          awesompleteInstance.list = [];
        }
      },
    });
  }, 250); // Reduced from 350ms to 250ms for faster response

  // Bind input listener
  field.$input.on("input", (e) => {
    const q = e.target.value;
    searchPlaces(q);
  });

  // When user chooses a suggestion
  inputEl.addEventListener("awesomplete-selectcomplete", (evt) => {
    const currentResults = inputEl.__bev_currentResults || [];
    const label = evt.text && (evt.text.value || evt.text);
    const match = currentResults.find((r) => r.label === label);
    if (!match) return;

    // Set name from selected location
    if (frm.doc.service_area !== match.value) {
      frm.set_value("service_area", match.value);
    }

    // CRITICAL: Save location coordinates to the location field
    // Frappe Geolocation field expects JSON string with lat and lng
    // Validate coordinates are valid before saving
    const lat = parseFloat(match.lat);
    const lng = parseFloat(match.lng);

    // Only save if coordinates are valid (not 0,0 and within valid ranges)
    if (
      !isNaN(lat) &&
      !isNaN(lng) &&
      lat !== 0 &&
      lng !== 0 &&
      lat >= -90 &&
      lat <= 90 &&
      lng >= -180 &&
      lng <= 180
    ) {
      const locationData = JSON.stringify({
        lat: lat,
        lng: lng,
      });

      if (frm.doc.location !== locationData) {
        frm.set_value("location", locationData);
      }
    } else {
      console.warn("Invalid coordinates detected:", lat, lng);
    }
  });
}

// ---------------------------------------------------------------------------
// Paste a location link: paste a Google Maps link or "lat, lng" into the
// Location link field and press Enter - the pin is placed on the map, the
// map moves to it, and the name is filled from the link when it is empty.
// ---------------------------------------------------------------------------

function parse_location_link_js(value) {
  if (!value || typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;

  const valid = (lat, lng) => {
    lat = parseFloat(lat);
    lng = parseFloat(lng);
    if (isNaN(lat) || isNaN(lng)) return null;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return { lat, lng };
  };

  // Plain "lat, lng"
  let m = text.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (m) {
    const c = valid(m[1], m[2]);
    if (c) return c;
  }

  // Google Maps "@lat,lng" (e.g. /place/.../@30.0444,31.2357,17z)
  m = text.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (m) {
    const c = valid(m[1], m[2]);
    if (c) return c;
  }

  // Google Maps data param "!3dLAT!4dLNG"
  m = text.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if (m) {
    const c = valid(m[1], m[2]);
    if (c) return c;
  }

  // Google Maps search URL: /maps/search/<lat>,<lng> (also /maps/search/<lat>,+<lng>)
  m = text.match(/\/search\/(-?\d+(?:\.\d+)?),\+?(-?\d+(?:\.\d+)?)/);
  if (m) {
    const c = valid(m[1], m[2]);
    if (c) return c;
  }

  // Query parameters: q / query / destination / center / ll
  try {
    const url = new URL(text);
    for (const key of ["q", "query", "destination", "center", "ll"]) {
      const raw = url.searchParams.get(key);
      if (raw) {
        const mm = raw
          .trim()
          .match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
        if (mm) {
          const c = valid(mm[1], mm[2]);
          if (c) return c;
        }
      }
    }
  } catch (e) {
    // Not a URL - nothing more to try
  }

  return null;
}

function extract_place_name_js(value) {
  // Google Maps /place/<name>/... - the place name is in the URL path
  const m = (value || "").match(/\/place\/([^\/\?]+)/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1].replace(/\+/g, " ")).trim() || null;
  } catch (e) {
    return null;
  }
}

function location_geojson_js(lat, lng) {
  // The GeoJSON FeatureCollection string Frappe stores for a Geolocation field
  return JSON.stringify({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: { type: "Point", coordinates: [lng, lat] },
      },
    ],
  });
}

function set_location_from_coords(frm, lat, lng, raw_value) {
  if (isNaN(lat) || isNaN(lng)) return;
  const geojson = location_geojson_js(lat, lng);
  if (frm.doc.location !== geojson) {
    frm.set_value("location", geojson);
  }
  // Fill the name from a /place/<name>/ link when the name is empty,
  // so the area is saved with the name of the place or the customer.
  if (!frm.doc.service_area) {
    const name = extract_place_name_js(raw_value || "");
    if (name) frm.set_value("service_area", name);
  }
  // The Geolocation control recenters the map on the pin when its value is
  // set (fit_and_recenter_map); nudge it as well once the control has drawn.
  setTimeout(() => {
    const ctrl = frm.fields_dict.location;
    if (ctrl && ctrl.map && ctrl.map.setView) {
      ctrl.map.setView([lat, lng], 15);
    }
  }, 400);
}

function apply_location_link(frm, raw_value) {
  const value = (raw_value || "").trim();
  if (!value) return;

  // Fast path: parse in the browser, no round trip
  const parsed = parse_location_link_js(value);
  if (parsed) {
    set_location_from_coords(frm, parsed.lat, parsed.lng, value);
    return;
  }

  // Anything else that looks like a link (e.g. a maps.app.goo.gl short link)
  // is resolved on the server, which follows the redirect and parses it.
  if (/^https?:\/\//i.test(value)) {
    frappe.call({
      method:
        "beveren_fsm.field_service_management.api.geocoding.resolve_location_link",
      args: { value: value },
      callback: (r) => {
        if (r && r.message && r.message.lat != null && r.message.lng != null) {
          set_location_from_coords(
            frm,
            parseFloat(r.message.lat),
            parseFloat(r.message.lng),
            value
          );
        } else {
          frappe.msgprint(
            __("Could not understand the pasted location link. Location was left unchanged.")
          );
        }
      },
    });
    return;
  }

  frappe.msgprint(
    __("Could not understand the pasted location link. Location was left unchanged.")
  );
}

function bind_location_link(frm) {
  const field = frm.fields_dict.location_link;
  if (!field || !field.$input || !field.$input.length) return;
  const inputEl = field.$input.get(0);
  if (!inputEl) return;

  // Avoid double-binding
  if (inputEl.__bev_location_link_bound) return;
  inputEl.__bev_location_link_bound = true;

  // Apply once per distinct pasted value (Enter and change can both fire)
  const apply_once = () => {
    const value = (inputEl.value || "").trim();
    if (!value || value === inputEl.__bev_last_applied_link) return;
    inputEl.__bev_last_applied_link = value;
    apply_location_link(frm, value);
  };

  // Enter: apply immediately
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      apply_once();
    }
  });

  // Paste + blur / field change: apply as well
  field.$input.on("change", apply_once);
}
