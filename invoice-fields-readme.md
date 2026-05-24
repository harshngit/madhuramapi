# Invoice Form Fields — Developer Reference

**Source:** Verified directly against client-provided invoice screenshots + Excel files.

Two templates: **Lodha** and **Hiranandani**. Both use Madhuram Enterprises as the supplier with different addresses.

---

## Template 1: Lodha

---

### Section 1 — Supplier / Company Details

| Field Label (as in Invoice) | Field Key | Type | Default Value |
|---|---|---|---|
| Company Name | `company_name` | Text | `Madhuram Enterprises` |
| Company Address | `company_address` | Textarea | `SHOP NO - S/2, FLOOR NO 2, X TH CENTRAL MAL, MAHAVIR NAGAR, KANDIVALI WEST, MUMBAI - 400 067, MAHARASHTRA` |
| Cell No. | `company_phone` | Text | `+919819408257` |
| Email Id | `company_email` | Email | `manish.plumbing@gmail.com` |
| Website | `company_website` | Text | `www.madhuramrealtors.com` |
| GSTIN | `supplier_gstin` | Text | `27AESPN7117D1ZA` |

> ⚠️ PAN, PF, ESIC, PTR, MLWF numbers are **NOT present** in the Lodha invoice. Do not add these fields for this template.

> ⚠️ Reverse Charge, Supplier State Name, Supplier State Code are **NOT present** in the Lodha invoice. Do not add these fields for this template.

---

### Section 2 — Invoice Details

| Field Label (as in Invoice) | Field Key | Type | Notes |
|---|---|---|---|
| Invoice No. | `invoice_number` | Text | e.g. `ME/EDENC-PL/3` |
| Invoice Date | `invoice_date` | Date | e.g. `6.3.2024` |

---

### Section 3 — Buyers Details (Bill-To, left side)

| Field Label (as in Invoice) | Field Key | Type | Notes |
|---|---|---|---|
| Name | `buyer_name` | Text | e.g. `COWTOWN INFOTECH SERVICES PRIVATE LIMITED` |
| Address | `buyer_address` | Textarea | e.g. `412, Floor-4, 17G Vardhaman Chamber, Cawasji Patel Rd, Fort, Mumbai - 400001` |
| State Name | `buyer_state_name` | Text | e.g. `MAHARASHTRA` |
| State Code | `buyer_state_code` | Text | e.g. `27` |
| GSTIN | `buyer_gstin` | Text | e.g. `27AAACC4889L1Z4` |

---

### Section 4 — Receiver Details (Ship-To, right side)

| Field Label (as in Invoice) | Field Key | Type | Notes |
|---|---|---|---|
| Receiver Name | `receiver_name` | Text | e.g. `COWTOWN INFOTECH SERVICES PRIVATE LIMITED` |
| Receiver Address | `receiver_address` | Textarea | e.g. `ANJUR CASA EDEN C` |
| Place of Supply | `place_of_supply` | Text | e.g. `EDEN C WING, ANJUR UPPER THANE` |

---

### Section 5 — Project / Work Details (right side)

| Field Label (as in Invoice) | Field Key | Type | Notes |
|---|---|---|---|
| WO No. | `work_order_number` | Text | e.g. `6100023272 DT 29.3.2023` |
| Plant Name | `plant_name` | Text | e.g. `ANJUR CASA EDEN C` |
| Bill No. (RA) | `bill_no` | Text | e.g. `RA 3` |

> ⚠️ Service Date From / To are **NOT present** in the Lodha invoice. Do not add these fields.

---

### Section 6 — Line Items Table

| Column Label (as in Invoice) | Field Key | Type | Notes |
|---|---|---|---|
| SN | `sn` | Auto-increment | Read-only |
| Description of Service / Goods | `description` | Text | e.g. `PLUMBING WORKS` |
| SAC / HSN Code | `sac_code` | Text | e.g. `998322` |
| Total Value of Goods / Services | `value_of_supply` | Number | User enters this |
| Discount | `discount` | Number | Default `0` |
| Taxable Value | `taxable_value` | Number | Auto-calc: Value of Supply − Discount |
| CGST Rate (%) | `cgst_rate` | Number | e.g. `9` |
| CGST Amount | `cgst_amount` | Number | Auto-calc |
| SGST Rate (%) | `sgst_rate` | Number | e.g. `9` |
| SGST Amount | `sgst_amount` | Number | Auto-calc |
| IGST if Any | `igst_amount` | Number | Auto-calc; shown as `-` when 0 — no separate rate input needed |
| Total | `line_total` | Number | Auto-calc: Taxable Value + CGST + SGST + IGST |

> ⚠️ **Cess is NOT present** in Lodha. Do not add Cess columns.
> ⚠️ IGST has **no rate input** in the Lodha invoice — it is shown as a single "IGST if Any" amount column only.

---

### Section 7 — Totals / Summary

| Field Label (as in Invoice) | Field Key | Type | Notes |
|---|---|---|---|
| Total (Taxable Value) | `total_taxable_value` | Number | Auto-calc |
| Total CGST | `total_cgst` | Number | Auto-calc |
| Total SGST | `total_sgst` | Number | Auto-calc |
| Total Value (sum row) | `total_value` | Number | Auto-calc: shown in totals row of table |
| Total Invoice Value (In figure) | `total_invoice_value` | Number | Auto-calc: final rounded amount |
| Total Invoice Value (In Words) | `total_invoice_value_words` | Text | Auto-generate in Indian format e.g. `EIGHT LAKH ELEVEN THOUSAND EIGHT HUNDRED AND SIXTY THREE ONLY` |

> ⚠️ **Round Off is NOT present** in Lodha. Do not add this field.

---

### Section 8 — Declaration / Signature

| Field Label (as in Invoice) | Field Key | Type | Notes |
|---|---|---|---|
| Declaration | `declaration` | Textarea | Static legal text about invoice copies (Original/Duplicate/Triplicate). Pre-fill but keep editable. |
| Electronic Reference Number | `electronic_ref_number` | Text | Can be blank |
| Electronic Reference Date | `electronic_ref_date` | Date | Can be blank |
| Authorised Signatory | `authorised_signatory` | Text | Default: `MADHURAM ENTERPRISES` |

---
---

## Template 2: Hiranandani

---

### Section 1 — Supplier / Company Details

| Field Label (as in Invoice) | Field Key | Type | Default Value |
|---|---|---|---|
| Company Name | `company_name` | Text | `Madhuram Enterprises` |
| Company Address | `company_address` | Textarea | `401, SUJATA BLDG, RAM NAGAR, OPP PARWANA BLDG, BORIVALI WEST, MUMBAI - 400092` |
| Cell No. | `company_phone` | Text | `+919819408257` |
| Email Id | `company_email` | Email | `manish.plumbing@gmail.com` |
| Website | `company_website` | Text | `www.madhuramrealtors.com` |
| GSTIN | `supplier_gstin` | Text | `27AESPN7117D1ZA` |
| PAN No. | `pan_number` | Text | `AESPN7117D` |
| PF No. | `pf_number` | Text | `KDMAL1528370000` |
| ESIC No. | `esic_number` | Text | `35000379650001009` |
| PTR No. | `ptr_number` | Text | `27501078216P` |
| MLWF No. | `mlwf_number` | Text | `MUMUMM000664` |

---

### Section 2 — Invoice Details

| Field Label (as in Invoice) | Field Key | Type | Notes |
|---|---|---|---|
| Invoice No. | `invoice_number` | Text | e.g. `EHC/FF/1` |
| Invoice Date | `invoice_date` | Date | e.g. `17.4.2025` |
| Reverse Charge (Y/N) | `reverse_charge` | Select (Y / N) | Default: `N` |
| State Name | `supplier_state_name` | Text | Default: `MAHARASHTRA` |
| State Code | `supplier_state_code` | Text | Default: `27` |

---

### Section 3 — Bill To Party (left side)

| Field Label (as in Invoice) | Field Key | Type | Notes |
|---|---|---|---|
| Co A/C Name | `bill_to_name` | Text | e.g. `HGP COMMUNITY PVT. LTD.` |
| Address | `bill_to_address` | Textarea | e.g. `Olympia, Central Avenue, Hiranandani Business Park, Powai, Mumbai 400 076` |
| GSTIN | `bill_to_gstin` | Text | e.g. `27AADCH8389P1ZL` |
| State | `bill_to_state` | Text | e.g. `Maharashtra` |
| State Code | `bill_to_state_code` | Text | e.g. `27` |

---

### Section 4 — Ship To Party / Site (right side)

| Field Label (as in Invoice) | Field Key | Type | Notes |
|---|---|---|---|
| Co A/C Name | `ship_to_name` | Text | |
| Address | `ship_to_address` | Textarea | |
| GSTIN | `ship_to_gstin` | Text | |
| State | `ship_to_state` | Text | e.g. `Maharashtra` |
| State Code | `ship_to_state_code` | Text | e.g. `27` |

---

### Section 5 — Project / Work Details

| Field Label (as in Invoice) | Field Key | Type | Notes |
|---|---|---|---|
| Building Name | `building_name` | Text | e.g. `EMPRESS HILL C WING` |
| RA No. | `ra_number` | Text | e.g. `1` |
| Work Description | `work_description` | Text | e.g. `FIRE FIGHTING WORKS` |
| WO No. | `work_order_number` | Text | e.g. `4700157329 DT 27.3.2025` |
| Service Date From | `service_date_from` | Date | e.g. `1.2.2025` |
| Service Date To | `service_date_to` | Date | e.g. `28.2.2025` |

> ⚠️ Work Order Date, Plant Name, and Bill No are **NOT present** in the Hiranandani invoice. Do not add these fields.

---

### Section 6 — Line Items Table

| Column Label (as in Invoice) | Field Key | Type | Notes |
|---|---|---|---|
| S. No. | `sn` | Auto-increment | Read-only |
| Goods / Service Description | `description` | Text | e.g. `FIRE FIGHTING works` |
| SAC Code | `sac_code` | Text | e.g. `995461` |
| Value of Supply | `value_of_supply` | Number | User enters this |
| Discount | `discount` | Number | Default `0` |
| Taxable Value | `taxable_value` | Number | Auto-calc: Value of Supply − Discount |
| CGST Rate (%) | `cgst_rate` | Number | e.g. `9` |
| CGST Amount | `cgst_amount` | Number | Auto-calc |
| SGST Rate (%) | `sgst_rate` | Number | e.g. `9` |
| SGST Amount | `sgst_amount` | Number | Auto-calc |
| Total | `line_total` | Number | Auto-calc: Taxable Value + CGST + SGST |

> ⚠️ **IGST and Cess are NOT present** in the Hiranandani invoice. Do not add these columns.

---

### Section 7 — Totals / Summary

| Field Label (as in Invoice) | Field Key | Type | Notes |
|---|---|---|---|
| Total Amount Before Tax | `total_before_tax` | Number | Auto-calc: sum of all Value of Supply |
| Total (Taxable Value) | `total_taxable_value` | Number | Auto-calc: sum of all Taxable Values |
| Total CGST | `total_cgst` | Number | Auto-calc |
| Total SGST | `total_sgst` | Number | Auto-calc |
| Round Off | `round_off` | Number | Auto-calc: difference to nearest rupee — can be negative e.g. `-0.36` |
| Total Amount After Tax | `total_amount_after_tax` | Number | Auto-calc: Taxable Value + CGST + SGST + Round Off |
| GST on Reverse Charge | `gst_on_reverse_charge` | Number | Usually `0` |
| Invoice Amount in Words | `invoice_amount_words` | Text | Auto-generate in Indian format e.g. `RUPEES THREE LAKH EIGHTY FOUR THOUSAND FOUR HUNDRED AND SEVENTY ONE ONLY` |

> ⚠️ There is only **one total invoice value** in Hira (Total Amount After Tax). The previous README had two separate "Total Value" and "Total Invoice Value" fields — this was incorrect. Use only `total_amount_after_tax`.

---

### Section 8 — Bank / Declaration

| Field Label (as in Invoice) | Field Key | Type | Notes |
|---|---|---|---|
| Bank Details | `bank_details` | Textarea | Can be blank — field exists in invoice |
| Terms and Conditions | `terms_and_conditions` | Textarea | Pre-fill with the 3 standard Madhuram clauses (see below) |
| Authorised Signatory | `authorised_signatory` | Text | Default: `M/S. MADHURAM ENTERPRISES` |

**Pre-filled Terms and Conditions (Hiranandani):**
```
1) This Invoice Should be Certified within 7 days of Invoice Date and Corrections should be intimated to us. In case not informed, this Invoice Value will be considered as final and uploaded in GSTN Returns.
2) In the event full payment is not made against the above invoice within 30 days from the date of certification / Tax Invoice, whichever is earlier, interest @ 24% p.a. shall be payable on the outstanding amount.
3) This invoice is subject to Mumbai Jurisdiction Only.
```

> ⚠️ Electronic Reference Number and Date are **NOT present** in the Hiranandani invoice. Do not add these fields.

---
---

## Side-by-Side Differences

| Feature | Lodha | Hiranandani |
|---|---|---|
| Company address | Kandivali West | Borivali West |
| PAN / PF / ESIC / PTR / MLWF | ❌ Not present | ✅ Present |
| Reverse Charge (Y/N) | ❌ Not present | ✅ Present |
| Supplier State Name + Code | ❌ Not present | ✅ Present |
| Buyer/Bill-To block | ✅ "Buyers Details" | ✅ "Bill to Party" |
| Ship-To / Receiver block | ✅ "Receiver Details" | ✅ "Ship to Party / Site" |
| Work Description (header field) | ❌ Not present | ✅ Present |
| Service Date From / To | ❌ Not present | ✅ Present |
| Work Order Date | ❌ Not present | ❌ Not present |
| Plant Name | ✅ Present | ❌ Not present |
| Bill No. | ✅ Present (RA No.) | ❌ Not present |
| IGST column | ✅ "IGST if Any" (amount only, no rate) | ❌ Not present |
| Cess columns | ❌ Not present | ❌ Not present |
| Round Off | ❌ Not present | ✅ Present |
| Total Before Tax | ❌ Not present | ✅ Present |
| Bank Details | ❌ Not present | ✅ Present |
| Terms and Conditions | ❌ Not present | ✅ Present (3 clauses, pre-filled) |
| Electronic Ref Number + Date | ✅ Present (can be blank) | ❌ Not present |

---

## Developer Notes

1. **Auto-calculations:** Taxable Value, all tax amounts, and all totals must be auto-calculated. Users only enter: Value of Supply, Discount, and Tax Rates.
2. **Amount in Words:** Auto-generate from the numeric total in Indian number format (Lakhs/Crores). Suffix with `ONLY`.
3. **Company defaults:** All supplier fields must be pre-filled per template but remain editable.
4. **Dynamic line items:** Items table must support adding and removing rows.
5. **Tax rate input:** Enter as a plain percentage number (e.g. `9` for 9%). Store and calculate as `value * rate / 100`.
6. **Round Off (Hira only):** `round_off = round(total) - total_before_rounding`. Can be negative.
7. **Excel export:** Map each field key to its exact cell position in the respective template Excel file.
