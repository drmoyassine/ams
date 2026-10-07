---
id: TASK-042
title: Form builder for data items, with form and sheet views
description: >-
  A data item's columns are its form's questions; answers from AMS users or a public link are kept as responses and
  added to the data as a version
status: completed
priority: P0
last_updated: '2026-10-07'
generated:
  by: agent/claude-code
  at: '2026-10-07T10:29:21.873Z'
roadmap_item:
  id: ROADMAP-004
  name: M3 — Evidence and datasets
  url: /ROADMAP.md#ROADMAP-004
depends_on:
  - id: TASK-040
    name: Datasets with manual upload, templates and data requests
    url: /TASKS.md#TASK-040
related_decisions:
  - id: DEC-020
    name: >-
      Data can be collected through forms, with an optional public link; responses join the data only when a person adds
      them
    url: /DECISIONS.md#DEC-020
modified:
  by: agent/claude-code
  at: '2026-10-07T10:29:21.873Z'
---
# TASK-042 — Form builder for data items, with form and sheet views

Built: `dataset_spec.form_open` and `form_link_token`, and `dataset_response` (migrations 0028-0029: visible with the item, audited; answers never change and a response is added to one version only). `app_resolve_form_link` finds an open form of an active, non-restricted item. The API's link access now names its target (`responseLink()` for requests, `formLink()` for forms); the route coverage test allows link access only on `/api/response-links/{token}` and `/api/form-links/{token}`. Answers are checked with the sheet's cell rules in the browser and on the server. "Add N responses to the data" saves the latest rows plus the new responses as the next version. UI: Sheet | Form | Responses tabs on a data item; the Form tab opens or closes the form, shows the AMS link (`/forms/{id}`) and creates, replaces or turns off the public link (`/f/{token}`), with a preview; questions take help text in the definition.

Requests connected to forms: a request may ask for a data item's form instead of a file (`evidence_request.data_item_id`, `response_id`; migrations 0030-0031 keep either target fixed). From the Form tab, "Ask people to fill it in" sends one request per address; AMS users get "Fill in the form" under Requests, others a one-time link whose page shows the form. The request is what lets them answer, so it works while the form is closed to everyone else; one answer closes it and becomes a response waiting to be added to the data. Restricted data is not requested through links.
