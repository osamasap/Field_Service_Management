import frappe
from frappe.utils import cint, getdate

from beveren_fsm.field_service_management.api.schedule_access import (
	get_allowed_service_order_names,
)


@frappe.whitelist()
def get_service_orders_for_tracking(
	status=None,
	start_date=None,
	end_date=None,
	search=None,
	limit_page_length: int | None = 50,
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

	or_filters = []
	if search:
		search_term = f"%{search.strip()}%"
		or_filters = [
			["Service Order", "name", "like", search_term],
			["Service Order", "customer", "like", search_term],
			["Service Order", "serial_no", "like", search_term],
			["Service Order", "item_code", "like", search_term],
		]

	fields = [
		"name",
		"customer",
		"status",
		"posting_date",
		"due_date",
		"serial_no",
		"item_code",
		"priority",
		"type",
		"product_location",
	]

	limit = int(limit_page_length) if limit_page_length else None

	orders = frappe.get_all(
		"Service Order",
		filters=filters,
		or_filters=or_filters,
		fields=fields,
		order_by="posting_date desc",
		limit_page_length=limit,
	)

	for order in orders:
		doc = frappe.get_doc("Service Order", order.name)
		order["product_movement"] = [
			{
				"name": movement.name,
				"movement_type": movement.movement_type,
				"destination": movement.destination,
				"movement_date": movement.movement_date,
				"linked_document_type": movement.linked_document_type,
				"linked_document": movement.linked_document,
				"handled_by": movement.handled_by,
				"service_order": order.name,
			}
			for movement in doc.product_movement
		]

	return orders


OPEN_ORDER_STATUSES = ["Open", "Scheduled", "Dispatched", "In Progress", "Review"]
COMPLETED_ORDER_STATUSES = ["Completed"]


def _service_orders_for_map(statuses, from_date=None, to_date=None):
	"""Core for the schedule-map order endpoints.

	Returns Service Orders whose status is in `statuses` (and whose
	posting_date falls in the optional from/to range) that resolve to map
	coordinates. Location is resolved from the order's own Location
	(Geolocation) field first, then from its linked Service Area's location.
	Only orders that resolve to coordinates are returned.
	"""
	from beveren_fsm.field_service_management.api.geocoding import parse_geolocation_value

	filters = {"docstatus": 1, "status": ["in", statuses]}
	if from_date and to_date:
		filters["posting_date"] = ["between", [getdate(from_date), getdate(to_date)]]
	elif from_date:
		filters["posting_date"] = [">=", getdate(from_date)]
	elif to_date:
		filters["posting_date"] = ["<=", getdate(to_date)]

	# Scope: only the orders this user is allowed to see on /schedule
	# (manager = all, technician = assigned, area responsible = their area).
	allowed = get_allowed_service_order_names()
	if allowed is not None:
		if not allowed:
			return []
		filters["name"] = ["in", allowed]

	orders = frappe.get_all(
		"Service Order",
		filters=filters,
		fields=["name", "customer", "status", "service_area", "product_location", "posting_date"],
		order_by="posting_date desc",
		limit_page_length=200,
	)

	result = []
	for order in orders:
		coords = None
		try:
			doc = frappe.get_doc("Service Order", order.name)
		except Exception:
			continue

		# 1) The order's own Location field (Geolocation)
		try:
			coords = parse_geolocation_value(getattr(doc, "location", None))
		except Exception:
			coords = None

		# 2) Fall back to the Service Area's location
		if not coords and doc.service_area:
			try:
				area = frappe.get_doc("Service Area", doc.service_area)
				coords = parse_geolocation_value(getattr(area, "location", None))
			except Exception:
				coords = None

		if not coords:
			continue

		result.append(
			{
				"name": order.name,
				"customer": order.customer,
				"status": order.status,
				"service_area": order.service_area,
				"product_location": order.product_location,
				"posting_date": str(order.posting_date) if order.posting_date else None,
				"location": {"lat": coords[0], "lng": coords[1]},
			}
		)

	return result


@frappe.whitelist()
def get_open_service_orders_for_map():
	"""Return open Service Orders that resolve to map coordinates.

	Kept for backwards compatibility; delegates to get_service_orders_for_map
	with the open statuses and no date bounds.
	"""
	return _service_orders_for_map(OPEN_ORDER_STATUSES)


@frappe.whitelist()
def get_service_orders_for_map(from_date=None, to_date=None, include_open=1, include_completed=0):
	"""Return Service Orders matching the schedule-map filter.

	Args:
		from_date / to_date: posting_date range (YYYY-MM-DD). When omitted,
			no date filter is applied.
		include_open: include open orders (status not Completed/Cancelled:
			Open, Scheduled, Dispatched, In Progress, Review).
		include_completed: include orders with status Completed.
		When neither box is checked, returns [].
	"""
	statuses = []
	if cint(include_open):
		statuses += OPEN_ORDER_STATUSES
	if cint(include_completed):
		statuses += COMPLETED_ORDER_STATUSES
	if not statuses:
		return []
	return _service_orders_for_map(statuses, from_date, to_date)


@frappe.whitelist()
def get_service_orders_for_schedule(limit_page_length=50):
	"""Service Orders for the /schedule left panel, scoped to the user.

	Same fields the panel used to fetch via /api/resource, but only the
	orders the user is allowed to see (manager = all, technician =
	assigned, area responsible = their area). Orders without a location
	are included too (unlike the map endpoint).
	"""
	filters = {"docstatus": 1}
	allowed = get_allowed_service_order_names()
	if allowed is not None:
		if not allowed:
			return []
		filters["name"] = ["in", allowed]
	return frappe.get_all(
		"Service Order",
		filters=filters,
		fields=["name", "customer", "status", "priority", "posting_date", "type"],
		order_by="posting_date desc",
		limit_page_length=cint(limit_page_length) or 50,
	)
