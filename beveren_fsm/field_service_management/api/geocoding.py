"""
API endpoints for geocoding and location search
Proxies Nominatim OpenStreetMap API requests to avoid CORS and rate limiting issues
"""

import json
import re
import time
import urllib.parse

import frappe

try:
	import requests

	HAS_REQUESTS = True
except ImportError:
	HAS_REQUESTS = False


# In-memory cache for rate limiting (per-session to avoid blocking other users)
_request_times = {}  # Store last request time per session
_min_request_interval = 0.5  # Reduced to 0.5 seconds for better UX (still respects Nominatim's limits)


@frappe.whitelist()
def search_places(query: str, limit: int = 7):
	"""
	Search for places using Nominatim OpenStreetMap API

	Args:
		query: Search query string (minimum 2 characters)
		limit: Maximum number of results to return (default: 7)

	Returns:
		List of place dictionaries with label, lat, lng
	"""
	if not query or len(query.strip()) < 2:
		return []

	# Rate limiting: ensure minimum interval between requests per session
	# Use session ID or user to avoid blocking other users
	session_key = frappe.session.user or "default"
	current_time = time.time()

	if session_key in _request_times:
		time_since_last = current_time - _request_times[session_key]
		if time_since_last < _min_request_interval:
			time.sleep(_min_request_interval - time_since_last)

	try:
		url = "https://nominatim.openstreetmap.org/search"
		params = {
			"format": "jsonv2",
			"q": query.strip(),
			"limit": min(limit, 10),  # Cap at 10 for safety
			"addressdetails": "1",
			"accept-language": frappe.local.lang or "en",
		}

		headers = {
			"Accept": "application/json",
			"User-Agent": frappe.conf.get("app_name") or "BeverenFSM/1.0",
		}

		if HAS_REQUESTS:
			response = requests.get(url, params=params, headers=headers, timeout=5)
			response.raise_for_status()
			data = response.json()
		else:
			# Fallback to urllib if requests is not available
			import urllib.parse
			import urllib.request

			url_with_params = url + "?" + urllib.parse.urlencode(params)
			req = urllib.request.Request(url_with_params, headers=headers)
			with urllib.request.urlopen(req, timeout=5) as response:
				data = json.loads(response.read().decode())

		# Update request time after successful API call
		_request_times[session_key] = time.time()

		# Ensure data is a list
		if not isinstance(data, list):
			frappe.log_error(
				message=f"Unexpected data type from Nominatim: {type(data)}\nQuery: {query}\nData: {data}",
				title="Geocoding API Error",
			)
			return []

		results = []
		for item in data:
			try:
				display_name = item.get("display_name", "")
				lat = item.get("lat")
				lon = item.get("lon")

				# Skip if missing required fields
				if not display_name or not lat or not lon:
					continue

				results.append(
					{
						"label": display_name,
						"value": display_name,
						"lat": float(lat),
						"lng": float(lon),
					}
				)
			except (ValueError, TypeError) as e:
				# Skip invalid entries
				frappe.log_error(
					message=f"Error parsing place data: {e!s}\nItem: {item}",
					title="Geocoding Parse Error",
				)
				continue

		return results

	except Exception as e:
		# Log error for debugging
		frappe.log_error(
			message=f"Error fetching places from Nominatim: {e!s}\nQuery: {query}",
			title="Geocoding API Error",
		)
		# Return empty list instead of raising exception
		return []


# ---------------------------------------------------------------------------
# Location parsing helpers (used by the schedule map and Service Order)
# ---------------------------------------------------------------------------

_COORD_PAIR_RE = re.compile(r"(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)")


def _valid_lat_lng(lat, lng):
	"""Validate and normalise a lat/lng pair. Returns (lat, lng) or None."""
	try:
		lat = float(lat)
		lng = float(lng)
	except (TypeError, ValueError):
		return None
	if not (-90.0 <= lat <= 90.0 and -180.0 <= lng <= 180.0):
		return None
	return (lat, lng)


def _parse_lat_lng_pair(text):
	"""Parse a plain 'lat, lng' string. Returns (lat, lng) or None."""
	if not text or not isinstance(text, str):
		return None
	match = _COORD_PAIR_RE.search(text.strip())
	if not match:
		return None
	return _valid_lat_lng(match.group(1), match.group(2))


def _parse_geojson(obj):
	"""Parse a GeoJSON object (FeatureCollection / Feature / Point).

	GeoJSON coordinates are [lng, lat]. Returns (lat, lng) or None.
	"""
	if not isinstance(obj, dict):
		return None
	obj_type = obj.get("type")
	if obj_type == "FeatureCollection":
		features = obj.get("features") or []
		if features:
			return _parse_geojson(features[0])
		return None
	if obj_type == "Feature":
		return _parse_geojson(obj.get("geometry") or {})
	if obj_type == "Point":
		coords = obj.get("coordinates") or []
		if len(coords) >= 2:
			return _valid_lat_lng(coords[1], coords[0])
	return None


def parse_geolocation_value(value):
	"""Parse a Frappe Geolocation field value (or a lat/lng dict/string).

	Handles:
	- dict {"lat": .., "lng": ..} or {"latitude": .., "longitude": ..}
	- GeoJSON dict or JSON string (FeatureCollection / Feature / Point,
	  coordinates are [lng, lat])
	- plain "lat, lng" string

	Returns (lat, lng) or None.
	"""
	if value is None:
		return None
	if isinstance(value, dict):
		if "lat" in value and "lng" in value:
			return _valid_lat_lng(value.get("lat"), value.get("lng"))
		if "latitude" in value and "longitude" in value:
			return _valid_lat_lng(value.get("latitude"), value.get("longitude"))
		return _parse_geojson(value)
	if isinstance(value, str):
		text = value.strip()
		if not text:
			return None
		if text.startswith("{"):
			try:
				return parse_geolocation_value(json.loads(text))
			except (ValueError, TypeError):
				pass
		return _parse_lat_lng_pair(text)
	return None


def geolocation_geojson(lat, lng):
	"""Build the GeoJSON FeatureCollection string Frappe stores for a Geolocation
	field, from a (lat, lng) pair. Coordinates are stored [lng, lat]."""
	return json.dumps(
		{
			"type": "FeatureCollection",
			"features": [
				{
					"type": "Feature",
					"properties": {},
					"geometry": {"type": "Point", "coordinates": [lng, lat]},
				}
			],
		}
	)


def _resolve_short_link(url):
	"""Follow a maps.app.goo.gl / goo.gl/maps short link to its final URL.

	Best-effort only; returns the final URL or None on any failure.
	"""
	try:
		if HAS_REQUESTS:
			resp = requests.get(
				url,
				timeout=5,
				allow_redirects=True,
				headers={"User-Agent": "Mozilla/5.0"},
			)
			return resp.url or None
		import urllib.request

		req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
		with urllib.request.urlopen(req, timeout=5) as resp:
			return resp.geturl() or None
	except Exception:
		return None


def parse_location_link(value):
	"""Parse a pasted location into (lat, lng).

	Handles:
	- plain "lat, lng" coordinates
	- Google Maps URLs: @lat,lng ; ?q= / ?query= / ?destination= / ?center= /
	  ?ll= lat,lng ; /place/.../@lat,lng ; !3dLAT!4dLNG
	- maps.app.goo.gl / goo.gl/maps short links (resolved, then parsed)

	Returns (lat, lng) or None. Never raises.
	"""
	if not value or not isinstance(value, str):
		return None
	text = value.strip()
	if not text:
		return None

	# Plain "lat, lng"
	coords = _parse_lat_lng_pair(text)
	if coords:
		return coords

	# Google Maps "@lat,lng" (e.g. /place/.../@30.0444,31.2357,17z)
	match = re.search(r"@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)", text)
	if match:
		coords = _valid_lat_lng(match.group(1), match.group(2))
		if coords:
			return coords

	# Google Maps data param "!3dLAT!4dLNG"
	match = re.search(r"!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)", text)
	if match:
		coords = _valid_lat_lng(match.group(1), match.group(2))
		if coords:
			return coords

	# Query parameters: q / query / destination / center / ll
	try:
		parsed = urllib.parse.urlparse(text)
		query = urllib.parse.parse_qs(parsed.query)
		for key in ("q", "query", "destination", "center", "ll"):
			for raw in query.get(key, []):
				coords = _parse_lat_lng_pair(raw)
				if coords:
					return coords
	except Exception:
		pass

	# Google Maps search URL: /maps/search/<lat>,<lng> (also /maps/search/<lat>,+<lng>)
	# This is the form a resolved maps.app.goo.gl short link lands on.
	match = re.search(r"/search/(-?\d+(?:\.\d+)?),\+?(-?\d+(?:\.\d+)?)", text)
	if match:
		coords = _valid_lat_lng(match.group(1), match.group(2))
		if coords:
			return coords

	# Short links: resolve the redirect, then parse the final URL
	if "maps.app.goo.gl" in text or "goo.gl/maps" in text:
		final_url = _resolve_short_link(text)
		if final_url and final_url != text:
			return parse_location_link(final_url)

	return None


@frappe.whitelist()
def resolve_location_link(value: str):
	"""Resolve a pasted location link / coordinates to {lat, lng}.

	Whitelisted wrapper around parse_location_link for the Service Area
	form, so short links (maps.app.goo.gl) can be resolved on Enter
	without saving. Returns None when the value cannot be understood.
	"""
	coords = parse_location_link(value)
	if not coords:
		return None
	lat, lng = coords
	return {"lat": lat, "lng": lng}
