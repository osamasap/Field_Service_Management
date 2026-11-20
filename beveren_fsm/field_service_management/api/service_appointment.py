"""
API endpoints for Service Appointment doctype
Handles fetching and reading service appointments from the backend
"""

import json

import frappe
from frappe.utils import getdate

from beveren_fsm.field_service_management.api.geocoding import parse_geolocation_value
from beveren_fsm.field_service_management.api.schedule_access import (
	get_allowed_appointment_names,
)



def _resolve_appointment_location(service_order_name):
	"""Resolve an appointment's map location from its Service Order.

	Prefers the Service Order's own Location (Geolocation) field, then falls
	back to the linked Service Area's location. Returns
	(location_data, service_area_name); location_data is
	{"lat": .., "lng": .., "service_area": ..} or None.
	"""
	location_data = None
	service_area_name = None
	try:
		service_order = frappe.get_doc("Service Order", service_order_name)
	except Exception:
		return None, None

	# 1) The order's own Location field (Geolocation)
	try:
		coords = parse_geolocation_value(getattr(service_order, "location", None))
	except Exception:
		coords = None

	if service_order.service_area:
		service_area_name = service_order.service_area

	# 2) Fall back to the Service Area's location
	if not coords and service_area_name:
		try:
			service_area_doc = frappe.get_doc("Service Area", service_area_name)
			coords = parse_geolocation_value(getattr(service_area_doc, "location", None))
		except Exception:
			coords = None

	if coords:
		location_data = {
			"lat": coords[0],
			"lng": coords[1],
			"service_area": service_area_name,
		}

	return location_data, service_area_name


@frappe.whitelist()
def get_appointments(
	posting_date=None,
	status=None,
	start_date=None,
	end_date=None,
	fields=None,
	limit_page_length=0,
):
	filters = {"docstatus": ["!=", 2]}

	if status and status != "all":
		filters["status"] = status

	if start_date and end_date:
		filters["posting_date"] = ["between", [getdate(start_date), getdate(end_date)]]
	elif start_date:
		filters["posting_date"] = [">=", getdate(start_date)]
	elif end_date:
		filters["posting_date"] = ["<=", getdate(end_date)]
	elif posting_date:
		posting_date = getdate(posting_date)
		filters["posting_date"] = posting_date

	default_fields = [
		"name",
		"service_order",
		"customer",
		"status",
		"posting_date",
		"scheduled_start_datetime",
		"scheduled_finish_datetime",
		"actual_start_datetime",
		"actual_finish_datetime",
		"service_type",
		"description",
		"naming_series",
	]

	if fields:
		if isinstance(fields, str):
			fields = json.loads(fields)
		requested_fields = fields
	else:
		requested_fields = default_fields

	# Scope: only the appointments this user is allowed to see on /schedule
	# (manager = all, technician = assigned, area responsible = their area).
	allowed = get_allowed_appointment_names()
	if allowed is not None:
		if not allowed:
			return []
		filters["name"] = ["in", allowed]

	appointments = frappe.get_all(
		"Service Appointment",
		filters=filters,
		fields=requested_fields,
		order_by="scheduled_start_datetime desc",
		limit_page_length=limit_page_length if limit_page_length > 0 else None,
	)

	# Enrich each appointment with full details including child tables
	enriched_appointments = []
	for appointment in appointments:
		appointment_doc = frappe.get_doc("Service Appointment", appointment.name)

		doc_dict = appointment_doc.as_dict(convert_dates_to_str=True)

		appointment_data = {field: doc_dict.get(field) for field in requested_fields if field in doc_dict}

		appointment_data["service_technicians"] = [
			{
				"service_technician": tech.service_technician,
				"full_name": tech.full_name,
				"name": tech.name,
			}
			for tech in appointment_doc.service_technicians
		]

		# Always include items child table
		appointment_data["items"] = [
			{
				"item_code": item.item_code,
				"item_name": item.item_name,
				"qty": item.qty,
				"rate": item.rate,
				"amount": item.amount,
				"uom": item.uom,
				"name": item.name,
			}
			for item in appointment_doc.items
		]

		# Fetch location from the Service Order (own Location, else Service Area)
		location_data = None
		service_area_name = None
		if appointment_data.get("service_order"):
			location_data, service_area_name = _resolve_appointment_location(
				appointment_data["service_order"]
			)
		if location_data:
			appointment_data["location"] = location_data
		elif service_area_name:
			# Include service area name even if location is missing
			appointment_data["service_area"] = service_area_name

		enriched_appointments.append(appointment_data)

	return enriched_appointments


@frappe.whitelist()
def get_appointment(name):
	"""
	Fetch a single service appointment by name

	Args:
		name: The name/ID of the service appointment

	Returns:
		Appointment dictionary with all fields including service_technicians and items
	"""
	if not name:
		frappe.throw("Appointment name is required")

	try:
		appointment_doc = frappe.get_doc("Service Appointment", name)
	except frappe.DoesNotExistError:
		frappe.throw(f"Service Appointment {name} not found", frappe.DoesNotExistError)

	appointment_data = appointment_doc.as_dict(convert_dates_to_str=True)

	appointment_data["service_technicians"] = [
		{
			"service_technician": tech.service_technician,
			"full_name": tech.full_name,
			"name": tech.name,
		}
		for tech in appointment_doc.service_technicians
	]

	# Format items child table
	appointment_data["items"] = [
		{
			"item_code": item.item_code,
			"item_name": item.item_name,
			"qty": item.qty,
			"rate": item.rate,
			"amount": item.amount,
			"uom": item.uom,
			"name": item.name,
		}
		for item in appointment_doc.items
	]

	# Fetch location from the Service Order (own Location, else Service Area)
	location_data = None
	service_area_name = None
	if appointment_data.get("service_order"):
		location_data, service_area_name = _resolve_appointment_location(
			appointment_data["service_order"]
		)
	if location_data:
		appointment_data["location"] = location_data
	elif service_area_name:
		appointment_data["service_area"] = service_area_name

	return appointment_data


@frappe.whitelist()
def get_appointment_statuses():
	"""
	Get all available status options for Service Appointment

	Returns:
		List of status options
	"""
	meta = frappe.get_meta("Service Appointment")
	status_field = meta.get_field("status")

	if status_field and status_field.options:
		options = status_field.options.strip()
		if options.startswith("[") and options.endswith("]"):
			try:
				return json.loads(options)
			except json.JSONDecodeError:
				pass
		statuses = [s.strip() for s in options.replace("\n", ",").split(",") if s.strip()]
		return statuses

	return ["Open", "Scheduled", "Dispatched", "In Progress", "Completed", "Cancelled"]


@frappe.whitelist()
def get_invoices_for_appointment(appointment_name: str, service_order: str | None = None, paid_only: int = 1):
	"""Fetch Sales Invoices linked to a Service Appointment or its Service Order.

	Args:
		appointment_name: Service Appointment name
		service_order: Optional Service Order name
		paid_only: If truthy, only return invoices with status 'Paid'

	Returns:
		List of dicts with invoice summary fields
	"""

	if not appointment_name:
		frappe.throw("Appointment name is required")

	fields = [
		"name",
		"status",
		"docstatus",
		"custom_reference_service_doctype",
		"custom_reference_service_document",
	]

	def query_for(ref_doctype: str, ref_doc: str):
		filters = {
			"custom_reference_service_doctype": ref_doctype,
			"custom_reference_service_document": ref_doc,
		}

		return frappe.get_all("Sales Invoice", fields=fields, filters=filters, limit_page_length=0)

	results = []
	results.extend(query_for("Service Appointment", appointment_name))

	if service_order:
		results.extend(query_for("Service Order", service_order))

	# Deduplicate by name while preserving order
	seen = set()
	unique_results = []

	for inv in results:
		if inv["name"] in seen:
			continue
		seen.add(inv["name"])
		unique_results.append(inv)

	return unique_results
