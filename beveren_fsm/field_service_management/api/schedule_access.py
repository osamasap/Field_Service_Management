"""Who may see what on the /schedule page.

Rules (Osama, 2026-11-20):
- A manager (Administrator, System Manager, or the Service Manager role)
  sees every Service Order.
- An installation technician sees only the Service Orders assigned to them
  (via the Service Appointments that list them in service_technicians).
- A user responsible for a Service Area (Service Area.responsible_user)
  sees only the Service Orders of that area.
- Anyone else sees nothing.
- Within the scope, open AND closed orders are both visible.
"""

import frappe


MANAGER_ROLES = ("System Manager", "Service Manager")


def _is_manager(user):
	if user == "Administrator":
		return True
	return bool(set(frappe.get_roles(user)) & set(MANAGER_ROLES))


def _technician_for_user(user):
	"""The Service Technician linked to this user (via Employee), or None."""
	employee = frappe.db.get_value("Employee", {"user_id": user}, "name")
	if not employee:
		return None
	return frappe.db.get_value("Service Technician", {"employee": employee}, "name")


def _areas_for_user(user):
	"""Service Areas this user is responsible for."""
	return frappe.get_all(
		"Service Area", filters={"responsible_user": user}, pluck="name"
	)


def get_allowed_service_order_names(user=None):
	"""Service Order names the user may see on /schedule.

	Returns None when the user may see ALL orders (manager), otherwise a
	list of order names (possibly empty).
	"""
	user = user or frappe.session.user
	if _is_manager(user):
		return None

	allowed = set()

	tech = _technician_for_user(user)
	if tech:
		appt_names = frappe.get_all(
			"Service Technician Item",
			filters={"service_technician": tech},
			pluck="parent",
		)
		if appt_names:
			order_names = frappe.get_all(
				"Service Appointment",
				filters={"name": ["in", appt_names], "docstatus": ["!=", 2]},
				pluck="service_order",
			)
			allowed.update(o for o in order_names if o)

	areas = _areas_for_user(user)
	if areas:
		area_orders = frappe.get_all(
			"Service Order",
			filters={"service_area": ["in", areas], "docstatus": 1},
			pluck="name",
		)
		allowed.update(area_orders)

	return sorted(allowed)


def get_allowed_appointment_names(user=None):
	"""Service Appointment names the user may see on /schedule.

	Returns None when the user may see ALL appointments (manager),
	otherwise a list of appointment names (possibly empty).
	"""
	user = user or frappe.session.user
	if _is_manager(user):
		return None

	allowed = set()

	tech = _technician_for_user(user)
	if tech:
		appt_names = frappe.get_all(
			"Service Technician Item",
			filters={"service_technician": tech},
			pluck="parent",
		)
		allowed.update(appt_names)

	areas = _areas_for_user(user)
	if areas:
		order_names = frappe.get_all(
			"Service Order",
			filters={"service_area": ["in", areas], "docstatus": 1},
			pluck="name",
		)
		if order_names:
			appts = frappe.get_all(
				"Service Appointment",
				filters={
					"service_order": ["in", order_names],
					"docstatus": ["!=", 2],
				},
				pluck="name",
			)
			allowed.update(appts)

	return sorted(allowed)
