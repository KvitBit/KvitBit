/**
 * Bundled `kvitbit://guide` static resource (`text/markdown`, section 6.7) and MCP server
 * `instructions` string (section 6.1).
 */
import type { Locale } from "@kvitbit/domain/contract";

export const MCP_SERVER_INSTRUCTIONS =
  "This MCP connection is bound to a single Kvitbit Workspace; no tool takes a workspaceId. " +
  "Read kvitbit://guide before drafting or issuing documents to understand Czech Tax Regimes, " +
  "VatTreatment values, the document lifecycle, and Document Lock. " +
  "Two-step rule: irreversible tools that assign a document number or send email " +
  "(issue_document, send_document, send_reminder, create_final_invoice, create_credit_note, " +
  'and create_from_template with as: "issued") require a preview call first (without confirm). ' +
  "Show summary.text to the user and only after explicit user approval call the same tool again " +
  "with identical arguments plus confirm: true and confirmationToken.";

const GUIDE_EN = `# Kvitbit MCP Guide

## Workspace binding
Every request runs inside the single Workspace bound to your OAuth grant. No tool accepts a \`workspaceId\`. Use \`get_workspace\` or \`kvitbit://workspace\` to inspect the active Issuing Entity, Tax Regime, bank accounts, and numbering series.

## Tax Regimes & VatTreatment
Never guess VAT percentages — Kvitbit computes Czech statutory rates from the document's tax point (\`taxableSupplyOn\`, or \`issuedOn\` for proformas) and each line's \`vatTreatment\`:

- **non_vat_payer**: Non-VAT payer (neplátce DPH). Lines use \`outside_scope\`; no VAT is charged and Payment Tax Documents are not issued.
- **vat_payer**: Czech VAT payer (plátce DPH). Choose per line:
  - \`standard\`: Czech standard VAT rate (21 %).
  - \`reduced\`: Czech reduced VAT rate (12 %).
  - \`exempt_intra_eu_goods\`: Exempt intra-EU supply of goods (0 %, requires EU buyer VAT ID).
  - \`reverse_charge\`: Domestic or EU reverse charge (0 %, customer self-assesses VAT).
  - \`outside_scope\`: Outside the scope of VAT (0 %).
- **identified_person**: Identified person (identifikovaná osoba). Domestic supplies are \`outside_scope\`; cross-border EU services/goods use \`reverse_charge\` or \`exempt_intra_eu_goods\`.

## Document Lifecycle
- **Draft** (\`status: "draft"\`): Editable via \`update_draft\`, no document number assigned yet.
- **Issued** (\`status: "issued"\`): Numbered from a gapless series. Cannot be edited via \`update_draft\` (returns \`Conflict{illegal_transition}\`).
- **Proforma -> Payment Tax Document -> Final Invoice**:
  1. Issue a \`proforma\` (not a tax document).
  2. Record payment with \`settle_proforma\` or \`record_payment\`. For a \`vat_payer\`, Kvitbit automatically issues a \`payment_tax_document\` (daňový doklad k přijaté platbě).
  3. Issue the Final Invoice with \`create_final_invoice\`, which deducts paid advances under §37a.
- **Credit Note**: Issue a full or partial correction against an issued Invoice or Payment Tax Document via \`create_credit_note\`.
- **Document Lock**: \`lock_document\` prevents further edits or cancellation.

## Two-step Preview and Confirm
Tools that assign a gapless document number or send email (\`issue_document\`, \`send_document\`, \`send_reminder\`, \`create_final_invoice\`, \`create_credit_note\`, and \`create_from_template\` with \`as: "issued"\`) work in two steps:
1. Call the tool **without** \`confirm\` / \`confirmationToken\`. Nothing is written. You receive \`ConfirmationRequired\` with \`summary.text\` and a 10-minute single-use \`confirmationToken\`.
2. Show \`summary.text\` to the user and get explicit approval.
3. Call the same tool again with the **exact same arguments** plus \`confirm: true\` and \`confirmationToken\`.

## Common IssueCodes
- \`request.malformed\`: Invalid field format or missing required field.
- \`vat.treatment_not_allowed_for_regime\`: Line \`vatTreatment\` does not match the Workspace's Tax Regime.
- \`document.no_bank_account_for_currency\`: Warning that no bank account matches the document currency.
- \`mcp.confirmation_required\`: Mixed \`confirm\` and \`confirmationToken\`.
- \`mcp.confirmation_invalid\`: Token is invalid or belongs to a different grant, user, Workspace, or tool.
- \`mcp.confirmation_mismatch\`: Arguments changed after the preview was shown.
- \`mcp.confirmation_expired\`: Token expired or was already consumed — preview again.
`;

const GUIDE_CS = `# Průvodce Kvitbit MCP

## Vazba na pracovní prostor
Každý požadavek běží v jednom pracovním prostoru navázaném na OAuth oprávnění. Žádný nástroj nepřijímá \`workspaceId\`. Použijte \`get_workspace\` nebo \`kvitbit://workspace\` pro zobrazení údajů výstavce, daňového režimu, bankovních účtů a číselných řad.

## Daňové režimy a VatTreatment
Neodhadujte sazby DPH — Kvitbit počítá zákonné české sazby z DUZP (\`taxableSupplyOn\`, u zálohové faktury \`issuedOn\`) a hodnoty \`vatTreatment\` na řádku:

- **non_vat_payer**: Neplátce DPH. Řádky používají \`outside_scope\`; DPH se neúčtuje a daňové doklady k platbě se nevystavují.
- **vat_payer**: Plátce DPH:
  - \`standard\`: Základní sazba DPH (21 %).
  - \`reduced\`: Snížená sazba DPH (12 %).
  - \`exempt_intra_eu_goods\`: Osvobozené dodání zboží do EU (0 %, vyžaduje DIČ odběratele v EU).
  - \`reverse_charge\`: Přenesená daňová povinnost (0 %).
  - \`outside_scope\`: Mimo předmět DPH (0 %).
- **identified_person**: Identifikovaná osoba. Tuzemská plnění jsou \`outside_scope\`; přeshraniční plnění v EU používají \`reverse_charge\` nebo \`exempt_intra_eu_goods\`.

## Životní cyklus dokladu
- **Koncept** (\`status: "draft"\`): Upravitelný přes \`update_draft\`, bez přiděleného čísla.
- **Vystavený doklad** (\`status: "issued"\`): Očíslovaný z bezmezerové řady. Nelze upravit přes \`update_draft\` (\`Conflict{illegal_transition}\`).
- **Zálohová faktura -> Daňový doklad k platbě -> Konečná faktura**:
  1. Vystavte zálohovou fakturu (\`proforma\`).
  2. Zaevidujte platbu přes \`settle_proforma\` nebo \`record_payment\`. U plátce DPH se automaticky vystaví daňový doklad k platbě.
  3. Vystavte konečnou fakturu přes \`create_final_invoice\` s odpočtem záloh (§37a).
- **Opravný daňový doklad (dobropis)**: Vystavte přes \`create_credit_note\`.
- **Uzamčení dokladu**: \`lock_document\` brání dalším úpravám i stornu.

## Dvoukrokové potvrzení (náhled -> potvrzení)
Nástroje, které přidělují číslo dokladu nebo odesílají e-mail (\`issue_document\`, \`send_document\`, \`send_reminder\`, \`create_final_invoice\`, \`create_credit_note\` a \`create_from_template\` s \`as: "issued"\`), pracují ve dvou krocích:
1. Zavolejte nástroj **bez** \`confirm\` a \`confirmationToken\`. Nic se nezapíše; obdržíte \`ConfirmationRequired\` se \`summary.text\` a jednorázovým \`confirmationToken\` (platnost 10 minut).
2. Ukažte \`summary.text\` uživateli a získejte jeho výslovný souhlas.
3. Zavolejte stejný nástroj znovu se **stejnými argumenty** plus \`confirm: true\` a \`confirmationToken\`.

## Časté kódy chyb (IssueCode)
- \`request.malformed\`: Neplatný formát pole nebo chybějící povinné pole.
- \`vat.treatment_not_allowed_for_regime\`: Hodnota \`vatTreatment\` neodpovídá daňovému režimu pracovního prostoru.
- \`mcp.confirmation_required\`: Chybí \`confirm\` nebo \`confirmationToken\`.
- \`mcp.confirmation_invalid\`: Neplatný token nebo token pro jiný grant, uživatele, pracovní prostor či nástroj.
- \`mcp.confirmation_mismatch\`: Argumenty byly po zobrazení náhledu změněny.
- \`mcp.confirmation_expired\`: Token vypršel nebo byl již použit — vyžádejte nový náhled.
`;

export const guideMarkdown = (locale: Locale): string => (locale === "cs" ? GUIDE_CS : GUIDE_EN);
