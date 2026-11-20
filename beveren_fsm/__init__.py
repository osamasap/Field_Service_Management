__version__ = "0.0.1"


def extend_pricing_allowlist():
    """Allow the FSM selling doctypes in ERPNext's pricing engine allow-list.

    ERPNext 16.60 added a security allow-list for the pricing engine
    (erpnext.accounts.doctype.pricing_rule.pricing_rule.PRICING_TRANSACTION_DOCTYPES).
    The FSM "Service Order" and "Service Quotation" doctypes use the pricing engine
    (selling price list / item rates), but they are not in that list, so opening
    their forms fails with "Invalid doctype" (HTTP 403) from apply_price_list.
    This extends the in-memory set; it does not modify any ERPNext core file.
    It is wired as a before_request hook (see hooks.py) so it runs in every
    web worker before any pricing call, and also applied here at app import.
    """
    try:
        from erpnext.accounts.doctype.pricing_rule import pricing_rule as _pricing_rule

        wanted = {"Service Order", "Service Quotation"}
        if not wanted <= _pricing_rule.PRICING_TRANSACTION_DOCTYPES:
            _pricing_rule.PRICING_TRANSACTION_DOCTYPES = (
                _pricing_rule.PRICING_TRANSACTION_DOCTYPES | wanted
            )
    except Exception:
        # Pricing engine not available (e.g. during install) - skip silently.
        pass


# Apply at app import (covers console / migrate / workers that import this app).
extend_pricing_allowlist()
