# Copyright (c) 2025, Beveren Software and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document


class ServiceArea(Document):
	def validate(self):
		self.apply_location_link()

	def apply_location_link(self):
		"""Save a pasted Google Maps link / coordinates into the Location field.

		If Location link holds a Google Maps link or "lat, lng", parse it and
		store the coordinates in the Location (Geolocation) field. The link is
		applied when Location is empty or when the link changed since the last
		save, so a manually adjusted Location is not overwritten on re-save.
		An unparseable link only shows a warning and leaves Location unchanged.
		"""
		link = (self.get("location_link") or "").strip()
		if not link:
			return
		try:
			from beveren_fsm.field_service_management.api.geocoding import (
				geolocation_geojson,
				parse_location_link,
			)
		except Exception:
			return
		coords = parse_location_link(link)
		if not coords:
			frappe.msgprint(
				_("Could not understand the pasted location link. Location was left unchanged."),
				indicator="orange",
			)
			return
		if self.get("location"):
			stored_link = None
			try:
				if not self.is_new():
					stored_link = frappe.db.get_value("Service Area", self.name, "location_link")
			except Exception:
				stored_link = None
			if stored_link == link:
				return
		lat, lng = coords
		self.location = geolocation_geojson(lat, lng)
