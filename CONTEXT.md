# Kvitbit

An invoicing and expense management domain for Czech and EU businesses, supporting multi-currency issuing, tax compliance, recurring billing, and received expense tracking.

## Language

### Organization and access

**Workspace**:
An isolated tenant representing one legal issuing entity, owning its contacts, documents, numbering series, templates, expenses, and team members.
_Avoid_: Account, organization, company tenant

**Issuing Entity**:
The legal subject (OSVČ or company with an IČO) that issues documents and receives expenses within a Workspace, including its tax regime, bank accounts, branding, and statutory footer.
_Avoid_: Supplier profile, seller, my company

**Member**:
A user granted access to a Workspace under one of four roles: `owner`, `admin`, `member`, or `accountant` (read-only and downloads).
_Avoid_: Team user, collaborator, seat

**Tax Regime**:
The Czech VAT status of an Issuing Entity: `non_vat_payer` (neplátce DPH), `vat_payer` (plátce DPH), or `identified_person` (identifikovaná osoba).
_Avoid_: VAT mode, tax type

**VAT Treatment**:
The VAT class of a line item: standard rate, reduced rate, exempt intra-EU supply of goods, reverse charge, or outside the scope of VAT.
_Avoid_: VAT code, tax rate, VAT type

**Rate Bucket**:
The group of a document's lines sharing one VAT Treatment and rate, on which the tax base and VAT are totalled and rounded.
_Avoid_: VAT group, tax line, rate summary

### Counterparties and catalog

**Contact**:
A customer or supplier saved in a Workspace, optionally populated from the Czech ARES business register by IČO.
_Avoid_: Subject, client, vendor, counterparty

**Price List Item**:
A reusable line-item catalog entry holding a default description, unit, unit price, currency, and VAT rate.
_Avoid_: Product, SKU, catalog item

### Issued documents

**Invoice**:
A regular payment and tax document (`faktura`) issued to a Contact for delivered goods or services.
_Avoid_: Bill, regular bill, payment request

**Proforma**:
A non-tax advance payment request (`zálohová faktura`) issued before delivery or payment.
_Avoid_: Advance invoice, deposit request

**Payment Tax Document**:
A tax document (`daňový doklad k přijaté platbě`) issued by a VAT payer upon receiving payment against a Proforma.
_Avoid_: Deposit receipt, tax receipt

**Final Invoice**:
The Invoice issued after a paid Proforma that bills the full supply and deducts the advance already paid, including VAT already declared on its Payment Tax Documents.
_Avoid_: Settlement invoice, final bill, closing invoice

**Credit Note**:
A corrective tax document (`opravný daňový doklad` or `dobropis`) that partially or fully offsets an issued Invoice.
_Avoid_: Refund invoice, corrective bill

**Cancellation**:
Voiding an issued document without deleting it: a tax document is offset by a full Credit Note, and a non-tax document is marked cancelled while keeping its number.
_Avoid_: Delete, void, storno

**Numbering Series**:
A named Workspace rule defining the sequential number pattern (such as `YYYY-NNNN`) and counter per document kind.
_Avoid_: Sequence, counter rule, format mask

**Invoice Template**:
A reusable blueprint of recipient, line items, currency, and terms used either for manual document creation or scheduled recurring issuance.
_Avoid_: Blueprint, recurring rule, preset

**Recurring Schedule**:
A cadence attached to an Invoice Template that automatically creates, issues, and optionally emails documents on a defined interval.
_Avoid_: Subscription, auto-invoice, cron job

**Occurrence**:
One calendar date on which a Recurring Schedule is due to produce a document; each Occurrence produces at most one document.
_Avoid_: Run, cycle, iteration

**Document Lock**:
An explicit state on an issued document that prevents further edits; unlocked issued documents remain editable with an audit history.
_Avoid_: Finalized, frozen, closed

**Audit Entry**:
An immutable record of one change to a Workspace record, naming who or which automated job made it, when, what changed, and why.
_Avoid_: Log line, change log, history item

**Public Share Link**:
A tokenized web URL for an issued document where the recipient views details, scans the QR Platba code, and downloads the PDF while recording view events.
_Avoid_: Web invoice, guest link, preview link

**Delivery**:
One attempt to email an issued document to recipients, such as the initial send, a payment reminder, or a Payment Tax Document, with its outcome.
_Avoid_: Email job, send, notification

**Payment Reminder**:
A Delivery sent automatically after the due date of an unpaid document, following the Workspace's reminder policy.
_Avoid_: Dunning, overdue notice, nag

### Expenses and payments

**Expense**:
A received invoice or receipt (`náklad`) recorded by a Workspace, with supplier details, dates, VAT breakdown, currency, category, payment status, and file attachments.
_Avoid_: Cost, bill, purchase, received invoice

**Payment**:
A recorded settlement event (full or partial) applied to an issued document or an Expense, with amount, currency, date, and method.
_Avoid_: Transaction, settlement, transfer

**QR Platba**:
A Czech SPAYD-formatted payment QR code embedded on issued documents and public share links for instant bank transfer scanning.
_Avoid_: Payment barcode, bank QR

**EPC QR**:
The European SEPA credit transfer QR code embedded on EUR documents, the counterpart of QR Platba for euro payments.
_Avoid_: SEPA QR, GiroCode, euro QR

**Exchange Rate Fixing**:
The Czech National Bank daily rate valid on a document's tax point, stored on the document and used to state VAT in CZK.
_Avoid_: FX rate, conversion rate, kurz
