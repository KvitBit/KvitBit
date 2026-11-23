# Czech invoicing, registry, FX, and SPAYD research

Research checked 2026-11-22. This is a product specification aid, not a legal opinion. Czech statutory text is authoritative; English strings below are app translations, not official translations.

## 1. Document requirements and wording

### Tax invoice scope and common fields

The VAT Act does not make every seller's “invoice” a VAT tax document. A tax document is a paper or electronic record meeting the Act (§26); electronic documents require the recipient's consent to use an electronic tax document, and the supplier remains responsible for correctness (§26(2)–(4)). From issue through retention, origin authenticity, content integrity, and legibility must be preserved (§34). These rules apply to PDF/email delivery and retention, but the law does not require Czech and English versions or prescribe an email body.

A VAT payer (plátce) must issue a tax document for (among other cases) supplies to a taxable person or non-taxable legal person (except exempt supplies without input deduction), qualifying intra-EU goods supplies, and advances where tax liability arises on receipt (§28(1)). The ordinary deadline is 15 days from the date tax liability or exempt-supply reporting obligation arises (§28(8)); special cross-border cases use the end-of-month timing in §28(9).

For a standard tax invoice, §29(1) requires:

- Supplier name/designation and VAT ID (DIČ); buyer name/designation and VAT ID.
- Sequential tax-document number.
- Scope and nature of the supply.
- Issue date and, if different, taxable-supply date or advance-payment receipt date.
- Unit price excluding VAT and any discount not already included.
- Tax base, VAT rate, and VAT amount; the VAT amount must be in CZK.

Exceptions: a party's VAT ID may be omitted if none was assigned; for advance documents the scope may be omitted if not yet known, and unit price/discount may be omitted where liability arose on the advance; rate and amount may be omitted for exempt supplies or where the recipient accounts for VAT (§29(3)). An exemption requires a reference to the relevant Czech/EU provision or other indication; customer self-billing requires “vystaveno zákazníkem”; recipient accounting requires “daň odvede zákazník” (§29(2)). Intra-EU reverse-charge supplies are excluded from simplified invoices, as are other recipient-liable supplies (§30(2)).

### Four requested document kinds

| App kind | Statutory treatment and fields |
|---|---|
| Regular invoice (faktura) | If it is a VAT tax document, use §29 fields and §28 issue triggers/deadlines. “Invoice” by itself is not a tax-document category. For a non-payer's ordinary commercial invoice, VAT-specific §29 fields do not apply; include business identity required by Civil Code §435 and contractual/payment information as needed. |
| Proforma (zálohová/proforma faktura) | No separately defined VAT tax-document class or statutory field list was found. Label clearly as a payment request/proforma, not a tax document, and do not make it an input-tax deduction document. Once a qualifying advance is received and VAT liability arises, issue the tax document for the received payment under §28(1)(d), with §29 advance exceptions. |
| Payment tax document (daňový doklad k přijaté platbě) | A tax document for an advance/received consideration, not a separately listed §29 format. Include §29 core fields; use the actual receipt date as tax point and omit unknown scope/unit price only where §29(3)(c)–(d) allows. Liability on an advance arises only where the intended supply is sufficiently known (§20a(2)); the document is due within 15 days under §28(8). |
| Credit note (opravný daňový doklad) | §45(1) requires supplier and buyer identities/DIČ, original invoice number, corrective document number, correction reason, delta in tax base, delta in VAT, delta in gross consideration, and correction date determined under §42(3). For ordinary base corrections, issue and use reasonable efforts to deliver within 15 days (§42(4)–(5)). Special omissions apply under §45(2)–(3). “Credit note” is not the statute's category name. |

For expenses (náklady), the app records supplier-issued evidence rather than issuing a new Czech tax invoice. Keep the original received document and its supplier, dates, currency, line/tax amounts, reference, and attachment. Input VAT deduction requires possession of the relevant tax document subject to §73; a generic expense record alone does not establish a deduction.

### Regime text and bilingual suggestions

The Czech strings below are statutory only where marked; English strings are product translations and should not be presented as official legal translations.

| Regime/context | Czech | English app translation | Legal status |
|---|---|---|---|
| Non-VAT payer | Dodavatel není plátcem DPH. | The supplier is not a VAT payer. | Suggested clarity text, not required phrase. Do not show VAT charged. |
| Identified person, domestic supply | Dodavatel je identifikovanou osobou k DPH; není plátcem DPH. | The supplier is an identified person for Czech VAT purposes and is not a VAT payer. | Suggested status clarification, not prescribed wording. Identified-person status alone does not make domestic supplies subject to output VAT. |
| Domestic reverse charge | Daň odvede zákazník. | Reverse charge. | Exact Czech wording required by §29(2)(c); the VAT Directive's exact English wording is “Reverse charge” (Art. 226(11a)). Use only where the recipient is liable for VAT. |
| EU B2B service, recipient liable | Daň odvede zákazník. | Reverse charge. | Use where the customer is legally liable. IDs/reporting obligations depend on transaction. For an identified-person supplier making a qualifying §9(1) service to another Member State, the Czech FS describes identification and recapitulative-report obligations. |
| Exempt intra-EU goods supply | Osvobozeno od DPH podle § 64 zákona č. 235/2004 Sb. | VAT-exempt intra-Community supply under Article 138 of Directive 2006/112/EC. | Exemption/reference, not a generic 0% rate or reverse-charge line. Conditions include the buyer's other-Member-State VAT ID and cross-border dispatch. |

Civil Code §435(1) requires every entrepreneur to put its name and registered office on business documents and publicly accessible online information; commercial-register businesses also include the register, section, and file number, and entrepreneurs in another public register include their registration information. The recommended “not a VAT payer” statement is separate from these identity particulars.

## 2. VAT arithmetic, rates, rounding, and currency conversion

- Current standard and reduced rates are 21% and 12% (§47(1)); the rate is selected by taxable-supply class and is the rate in force on the tax-liability date (§47(2)–(4)). The Act does not define a general 0% domestic rate. Model 0% as a qualifying zero-rated/exempt transaction (for example §64 intra-community goods) or another distinct treatment, not a general third domestic rate.
- Tax base includes consideration excluding VAT plus specified taxes/fees and incidental costs charged to the customer (including packaging, transport, insurance, and commission); discounts granted by the tax point reduce the base (§36(1), (3)–(5)).
- “Bottom-up” tax: base × rate (§37(a)). “Top-down” for a VAT-inclusive amount: VAT-inclusive consideration, excluding qualifying whole-koruna payment rounding, minus that amount divided by 1.21 or 1.12 (§37(b)). Advance bases are netted from the final supply under §37a.
- §29(1)(l) requires VAT amount in CZK. Under §4(8), convert foreign-currency amounts using the rate applicable to the person performing the conversion on the date tax liability (or exempt-supply reporting obligation) arises: CNB market rate or ECB reference rate; for currencies other than EUR, cross via each currency's EUR rate. If neither publishes a rate for the currency, use CNB's “other currencies” rate. Do not use invoice issue date solely for convenience.
- The Act excludes whole-koruna rounding of total consideration at payment from the base (§36(5)); §37(b) explicitly excludes that rounding from the VAT calculation. Current FS guidance says cents can be used for cashless payment, and if the supplier nevertheless rounds the total by a whole koruna, that difference does not enter the base. Higher rounding is taxable. FS guidance describes §37 as preventing repeated rounding.
- No per-line-versus-per-rate-bucket rounding rule was found in §§29, 36, or 37. Those provisions do not prescribe line VAT rounding or require calculation rounding per line or per rate bucket. Preserve calculation precision, calculate VAT by rate, and make display/rounding policy explicit; the cited law does not decide the implementation choice.

## 3. ARES API and VAT-status lookup

### ARES

Official live OpenAPI: https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/v3/api-docs (queried 2026-11-22; OAS info.version 1.4). Main routes:

- GET /ekonomicke-subjekty/{ico} (vratEkonomickySubjekt): one IČO, exactly eight digits.
- POST /ekonomicke-subjekty/vyhledat (vyhledejEkonomickeSubjekty): search/list query.
- Registry-specific detail/search routes include /ekonomicke-subjekty-res/{ico}, /ekonomicke-subjekty-rzp/{ico}, /ekonomicke-subjekty-vr/{ico}, /ekonomicke-subjekty-ros/{ico}, and other registered source services.

Relevant core response fields include ico, obchodniJmeno, sidlo, pravniForma, dic (DIČ), dicSkDph (group VAT ID), datumVzniku, datumZaniku, datumAktualizace, and seznamRegistraci.stavZdrojeDph. The checked-in local API subset documents the core GET and schemas in /home/dev/Projects/deskohub/packages/ares/openapi/ares-api.yaml (v1.3.0, extracted 2026-09-26; schema lines 25–69, 77–138, 153–191, and 341–425).

Do not infer current VAT-payer status from existence of dic or dicSkDph. stavZdrojeDph is the status of the DPH data source in ARES, not a direct payer-status boolean. For a decision-grade domestic check, use the Ministry of Finance/Financial Administration VAT Register or its RWS service. Official FS describes the VAT Register as containing VAT payers, identified persons, and unreliable payers. Its SOAP RWS operation getStatusNespolehlivyPlatce checks DIČ and returns unreliable-payer status, disclosed accounts, competent tax office, subject identity/address, and not-found status; the 2023 service update adds whether the queried tax subject is an identified person. Published safeguards are thresholds of 10,000 calls/24h, 2,000/hour, and 4 concurrent calls; authority reserves the right to change them. RWS is SOAP, not REST. Use VIES separately where the needed check is EU VAT-ID validation.

ARES says access can be limited/blocked for more than 500 queries/minute and abusive patterns (repeated bad/identical requests, excessive concurrency, random automated enumeration, or IP rotation). This is an abuse ceiling, not a documented throughput SLA. Cache sensible lookups, validate IČO before requests, and avoid parallel fan-out.

## 4. CNB daily FX feed

Official daily TXT URL for a requested date:

https://www.cnb.cz/cs/financni-trhy/devizovy-trh/kurzy-devizoveho-trhu/kurzy-devizoveho-trhu/denni_kurz.txt?date=DD.MM.RRRR

Without the date parameter the same URL returns the latest available fixing. Date format is DD.MM.RRRR. TXT structure:

1. First line: fixing date, one space, #, annual publication sequence (example 03.01.2000 #1).
2. Header: země|měna|množství|kód|kurz.
3. One currency per line, pipe-delimited; decimal comma (example Austrálie|dolar|1|AUD|23,282).

Use množství as the denominator as well as kurz; some currencies are quoted per 100 or 10,000 units. CNB updates the current-day feed once on working days “around 14.30”; treat this as approximate, not an exact SLA. Rates are declared on working days and valid for that working day and, where relevant, the following Saturday, Sunday, and public holiday. A no-publication day therefore uses the latest fixing still valid until a new fixing is published. CNB JSON API also exposes /cnbapi/exrates (fixing) and /cnbapi/fxrates (other currencies); daily TXT is a simple stable source.

## 5. SPAYD / QR Platba

Use Czech Banking Association standard 1.2 (issued 2021-06-01, effective 2022-01-01). Revision 1.2 still uses payment-string header SPD*1.0*; 1.2 is the standard revision, not the payload protocol version. It is intended for domestic CZK payments; v1.2 says only CZK is currently permitted. Do not encode non-CZK invoice currency as if QR Platba supported it.

| Key | Required? | Value limit/format | Meaning |
|---|---:|---|---|
| ACC | Yes | Max 46 chars total: IBAN plus optional +BIC | Payee account; IBAN required, BIC optional. |
| AM | No | Max 10 chars, decimal, up to 2 decimals, dot separator; up to 9,999,999.99 | Amount. |
| CC | No | Exactly 3 uppercase ISO 4217 letters; current Czech scheme permits only CZK | Currency. |
| RN | No | Max 35 chars; permitted character set excluding * | Recipient name. |
| DT | No | Exactly 8 digits, YYYYMMDD | Due date. |
| MSG | No | Max 60 chars; permitted character set excluding * | Remittance message. |
| X-VS | No | Max 10 digits | Variable symbol. |
| X-KS | No | Max 10 digits | Constant symbol. |
| X-SS | No | Max 10 digits | Specific symbol. |

Fields are KEY:value* with * separating fields. Values must not have surrounding whitespace or an unescaped *; special characters can be URL-encoded (* as %2A). The standard allows UTF-8 but recommends QR-efficient characters 0–9, uppercase A–Z, space, $ % * + - . / :; other characters use binary QR mode. Overlong values may be truncated by readers, so enforce limits before encoding. The specification has no single overall SPAYD string limit: actual QR capacity depends on QR version and encoding density. It recommends error-correction level M and a print size suitable for resulting density.

Local reference: /home/dev/Projects/deskohub/packages/qr-code/src/index.ts (lines 1–51) generates a QR image from arbitrary plaintext and sets error correction M, but does not parse/validate SPAYD fields; validation must be implemented separately.

## Sources and access notes

Statutes were cross-checked against current-in-2026 e-Sbírka entries and a line-readable consolidation (accessed 2026-11-22). The government portal identifies e-Sbírka as the source for complete/current law. e-Sbírka's JavaScript page returned no readable body in the web reader, so line-number citations below refer to the consolidation; use linked e-Sbírka text as authoritative.

- VAT Act 235/2004 Sb., current e-Sbírka: https://e-sbirka.gov.cz/sb/2004/235?zalozka=text; readable consolidation: https://www.zakonyprolidi.cz/cs/2004-235. Relevant: §§4(8), 20a(2), 26, 28–30a, 34, 36–37a, 42–45, 47, 64. Key line groups in consolidation: §4(8) 285–292; §28 1367–1420; §29 1426–1483; §30 1495–1523; §§36–37 1702–1806; §§42/45 1857–1893, 1961–1991; §47 2398–2410; §64 2901–2911.
- Civil Code 89/2012 Sb. §435: https://www.zakonyprolidi.cz/cs/2012-89; official e-Sbírka: https://e-sbirka.gov.cz/sb/2012/89?zalozka=text.
- VAT Directive 2006/112/EC, EUR-Lex consolidated 2025-04-14: https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:02006L0112-20250414. Relevant: Art. 226(11), (11a), Art. 138.
- European Commission VAT identification numbers and VIES validation: https://taxation-customs.ec.europa.eu/taxation/vat/vat-directive/vat-identification-numbers_en.
- CNB daily feed/format FAQ: https://www.cnb.cz/cs/casto-kladene-dotazy/Kurzy-devizoveho-trhu-na-www-strankach-CNB, lines 377–450. Weekend/holiday validity: CNB methodology sheet https://www.cnb.cz/docs/ARADY/MET_LIST/kurzy_en.pdf.
- ARES official service/operating terms: https://data.mf.gov.cz/api/ares.html, lines 0–14. Live OpenAPI v1.4: https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/v3/api-docs. Swagger: https://ares.gov.cz/swagger-ui/.
- Financial Administration VAT Register/RWS: https://financnisprava.gov.cz/cs/dane/dane-elektronicky/danovy-portal/registr-dph; RWS tech info/limits: https://adisspr.mfcr.cz/pmd/dokumentace/webove-sluzby-spolehlivost-platcu. Identified-person duties: https://financnisprava.gov.cz/cs/mezinarodni-spoluprace/mezinarodni-spoluprace-a-dph/informace-pro-platce-dph-k-vybranym-ustanovenim-zakona, lines 64–72.
- FS VAT rounding/calculation guidance: https://financnisprava.gov.cz/cs/financni-sprava/novinky/novinky-2019/vypocet-dph-a-zaokrouhlovani-od-1-10-2019, lines 12–27.
- CBA QR Platba standard v1.2: https://qr-platba.cz/wp-content/uploads/1645-standard-qr-v1-2-cerven-2021.pdf. Relevant PDF lines: 0–11 (revision); 92–128 (encoding); 135–257 (base keys); 371–414 (X symbols); 456–472 (bank support); 586+ (QR size).
- Local reference packages: ARES /home/dev/Projects/deskohub/packages/ares/openapi/ares-api.yaml; QR renderer /home/dev/Projects/deskohub/packages/qr-code/src/index.ts.

## Not verified / limits

- No official statutory English translation was found. English phrases here are translations; Czech reverse-charge wording and the EU Directive English phrase are cited.
- The VAT Act sections examined do not establish a universal per-line versus per-rate-bucket VAT rounding order. This remains an implementation/accounting policy choice; no statutory rule is invented.
- The ARES 500/min restriction is stated as grounds to restrict access, not as a guaranteed API quota. ARES field freshness and the precise live vocabulary of stavZdrojeDph were not validated against a sample taxpayer response.
- CNB publication “around 14:30” is approximate; no exact-time guarantee was found.
