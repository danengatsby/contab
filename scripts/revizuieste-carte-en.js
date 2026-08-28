#!/usr/bin/env node
'use strict';

// Deterministic editorial pass applied after machine/API translation. It standardises the
// professional working-paper vocabulary and curates the chapters added in the 2026 edition.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, 'carte', 'en');

function set(root, keys, value) {
  let current = root;
  for (const key of keys.slice(0, -1)) current = current[key];
  current[keys.at(-1)] = value;
}

const standardNote = 'The conclusion is dated and signed by the preparer; the reviewer documents each review note and its resolution. Cross-references must allow the trail back to the trial balance, supporting document and deliverable to be reperformed.';

const dossierRows = {
  24: ['lease classification and separation of its components', 'contract, payment schedule, minutes, invoices, options and fixed asset register', 'assess the economic substance, recompute principal and interest, and verify the asset, liability and VAT', 'classification based only on the security, or the full instalment charged to expense'],
  25: ['recognition of revenue and expenses in the correct economic period', 'contracts, invoices, receiving reports, subscriptions and adjustment calculations', 'test unbilled purchases/sales and prepayments/deferred income before and after closing', 'invoice date used automatically instead of the period in which the service was supplied'],
  26: ['complete remeasurement of monetary items denominated in foreign currencies', 'foreign-currency documents, official exchange rates, statements and ledgers by currency', 'recompute the amount at the transaction, settlement and reporting dates', 'subledgers kept only in lei, with no foreign-currency amount, or forced exchange differences'],
  27: ['assessment of receivable recoverability and the required impairment adjustments', 'ageing, litigation, correspondence, subsequent receipts and estimates', 'test indicators by customer and separately recompute the accounting and tax adjustments', 'standard percentage applied without analysis, or old receivables left unadjusted'],
  28: ['recognition in the correct economic period', 'contracts, invoices, receivables, subscriptions and allocation calculations', 'test prepayments, deferred income and unbilled purchases/sales', 'invoice date used automatically instead of the period receiving the benefit'],
  29: ['retention of a controlled audit trail for every correction', 'original document, reason, approval, reversal and corrected document', 'follow the two-way link and the effect on tax returns', 'deletion, overwriting or reversal with no reference to the original'],
  30: ['completeness and accuracy of mandatory registers', 'registers, trial balances, sequences and extraction parameters', 'reconcile period totals and investigate exclusions', 'report regenerated later under different rules and with no version record'],
  31: ['agreement between the trial balance, general ledger and subledgers', 'trial balance, ledger accounts, journals and source reports', 'recompute movements and balances and verify that subledger totals agree with the control account', 'differences dismissed as rounding without tracing them to documents'],
  32: ['independence and integrity of reconciliations', 'signed reconciliation, external sources and differences register', 'reperform material items and investigate old unresolved differences', 'reconciliation that changes the source data merely to force agreement'],
  33: ['detection of errors that do not disturb debit–credit equality', 'trend analyses, confirmations, classification documents and targeted tests', 'design procedures around assertions, not only total debits equalling total credits', 'correctness concluded solely because the trial balance balances'],
  34: ['completeness and accuracy of receivable and payable maturities', 'partner subledgers, contracts, due dates, confirmations and subsequent receipts/payments', 'reconcile to the trial balance and test maturity, ageing, disputes and cash flows', 'default due dates, old balances with no action, or assumed set-offs'],
  35: ['recognition of VAT only when the legal and documentary requirements are met', 'invoices, VAT registers, counterparty status, use and reporting period', 'test chargeability, deduction entitlement, rate and restrictions', 'VAT deducted solely because it is separately stated on the invoice'],
  36: ['identification and correct application of special VAT schemes', 'options, ANAF registers, invoices, receipts/payments and scheme calculations', 'verify eligibility, entry/exit, chargeability and the threshold for the period', 'special scheme retained after its conditions cease or applied retroactively'],
  37: ['completeness of the filing calendar and accuracy of every return', 'tax vector, source registers, forms, validations and calendar', 'reconcile each obligation to its source and verify the form version, period and deadline', 'return generated from a provisional trial balance or obsolete form'],
  38: ['proof of valid filing and follow-up of authority messages', 'signed file, submission index, receipt, errors, resubmission and confirmation', 'follow each filing through to a valid receipt and reconcile the accepted version', 'uploaded file treated as filed despite a missing receipt or unresolved errors'],
  39: ['compliance with dependencies and completeness of the monthly close', 'calendar, checklist, reconciliations, returns, approvals and statuses', 'select one month and reperform the sequence through locking, including exceptions', 'returns filed before documents and reconciliations are complete'],
  40: ['objective derivation of each workflow status from source data', 'status rules, source reports, exceptions and calculation log', 'recompute sample statuses and test the return from ready to open', 'manually checked status even though source data show unresolved items'],
  41: ['integrity of locked periods and control over reopening', 'permissions, logs, approvals, reasons and before/after outputs', 'inspect every subsequent posting and its propagation to returns and reports', 'informal reopening, or changes after filing without the required correction'],
  42: ['correct closure of revenue and expense accounts and transfer of the result', 'pre/post-close trial balances, closing entries and result calculation', 'reperform the closing and verify zero balances in classes 6 and 7', 'manual entries moving expenses to obtain a desired result'],
  43: ['complete bridge from accounting result to corporate income tax', 'tax records register, trial balance, D101, tax losses and incentive records', 'recompute adjustments in the statutory order and reconcile the return', '16% applied directly to accounting profit, or a tax credit deducted from the tax base'],
  44: ['lawful appropriation and payment of profit', 'approved financial statements, resolutions, reserves, net-assets calculation, account 457 and payments', 'recompute distributable profit, restrictions and tax', 'dividend paid before the tests, or shareholder loan repaid while legally restricted'],
  45: ['complete presentation and sound analysis of performance', 'mapped trial balance, income statement, notes and comparisons', 'reconcile each line and distinguish recurring from unusual items', 'profit improved through reclassification or a non-recurring event'],
  46: ['existence, measurement and classification of the financial position', 'trial balance, maturities and lead schedules', 'reconcile statement lines and test current/non-current classification and set-offs', 'balance-sheet equality used as the sole test of correctness'],
  47: ['completeness of the notes and consistency with figures and risks', 'disclosure checklist, contracts, policies and supporting schedules', 'link each disclosure requirement to the trial balance and supporting rationale', 'prior-year wording copied with obsolete data and risks'],
  48: ['cross-statement consistency of the complete reporting package', 'all statements, trial balance, cash flow and statement of changes in equity', 'reperform cross-checks and investigate every difference, including forced zeros', 'forms manually adjusted without correcting the source trial balance'],
  49: ['integrity, accessibility and preservation of the archive', 'file plan, index, retention policies, backups and restoration tests', 'select older documents and attempt to locate, read and trace them', 'files that exist but are illegible, unindexed or lack a verified backup'],
  50: ['traceability of actions and segregation of access', 'immutable logs, users, roles, approvals and incidents', 'trace who created, changed, approved and exported each transaction', 'shared accounts, editable logs or unexplained administrator interventions'],
  51: ['control over automation while preserving human judgment', 'rules, versions, tests, exceptions, confirmations and model log', 'test boundary cases and manually review high-risk transactions', 'broad automation with no owner, thresholds or error monitoring'],
  52: ['correct classification of policies, estimates and errors', 'memorandum, policies, dated information, materiality assessment and approvals', 'reconstruct the information then available and verify prospective or retrospective treatment', 'account 1174 used without demonstrating both a prior-period error and materiality'],
  53: ['completeness of uncertain obligations and appropriateness of the going-concern basis', 'legal correspondence, provisions, subsequent events, cash flows and scenarios', 'test recognition criteria, the estimate, subsequent updates and liquidity sensitivity', 'provision used for profit smoothing, or going concern supported only by promises'],
  54: ['substance and legality of transactions with shareholders and related parties', 'related-party map, contracts, confirmations, net-assets calculation and resolutions', 'reconcile by nature and verify restrictions before payment', 'unsupported withdrawals, artificial set-offs or non-arm’s-length terms'],
  55: ['traceability of the professional conclusion to every reported line', 'index, risk matrix, lead schedules, evidence and open points', 'select one line and reperform the trail through the trial balance, procedure, exceptions and approval', 'tick marks with no procedure, source, author, date or conclusion']
};

for (let chapter = 1; chapter <= 55; chapter += 1) {
  const file = path.join(ROOT, `cuprins-carte-cap${chapter}.json`);
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  const dossier = json.blocuri.find((block) => /working (papers|file)/i.test(block.titlu || ''));
  if (dossier) {
    dossier.titlu = 'Professional working papers';
    dossier.cap = ['Objective', 'Evidence to retain', 'Review procedure', 'Risk indicator'];
    dossier.nota = standardNote;
    if (dossierRows[chapter]) dossier.randuri[0] = dossierRows[chapter];
  }
  fs.writeFileSync(file, `${JSON.stringify(json, null, 1)}\n`);
}

const editorial = {
  'cuprins-carte.json': [
    [['parti', 11, 'capitole', 0, 'titlu'], 'Accounting policies, estimates, errors and materiality'],
    [['parti', 11, 'capitole', 3, 'titlu'], 'Working papers and professional review'],
    [['parti', 12, 'capitole', 5, 'titlu'], 'Legislative map and update protocol']
  ],
  'cuprins-carte-cap23.json': [
    [['blocuri', 3, 'text'], 'For accounting purposes, an item is recognised as a fixed asset when the company controls it, expects economic benefits from its use and intends to use it for more than one year; the capitalisation threshold is set by accounting policy with regard to materiality. The tax concept is narrower: from 2026, a depreciable fixed asset must have a tax value of at least 5.000 lei under Article 28(2)(b) of the Tax Code, a limit that may be updated annually for inflation by government decision. Document the two tests separately.'],
    [['blocuri', 4, 'text'], 'A 2.000 lei telephone used for three years may be expensed immediately under the company’s approved capitalisation threshold, while remaining a controlled item tracked in the inventory records if policy requires. A 200.000 lei stock of merchandise is not a fixed asset, regardless of amount: it is held for sale rather than use. Value alone does not determine classification.'],
    [['blocuri', 32, 'titlu'], 'For the accountant'],
    [['blocuri', 32, 'text'], 'Tax depreciation is governed by Article 28 of the Tax Code, while normal useful-life ranges come from the catalogue approved by HG 2139/2004. For 2026, OUG 8/2026 increased the tax threshold for a fixed asset to 5.000 lei and introduced superaccelerated depreciation of up to 65% in the first year for eligible new assets in subgroups 2.1 and 2.4. Five practical points follow. First, the tax threshold does not replace the accounting capitalisation policy; differences are tracked in the tax records register. Second, the catalogue provides ranges, and the selected useful life must reflect expected use rather than tax minimisation. Third, declining-balance depreciation requires switching to straight-line when the latter becomes higher; failing to switch leaves an amount undepreciated at the end. Fourth, track accounting–tax differences cumulatively for each asset, including on disposal. Fifth, the 1.500 lei cap for M1 vehicles applies monthly and is not carried forward. The asset file includes the invoice, receipt, commissioning report, catalogue classification, approved useful life and method, accounting and tax calculations, improvements, stocktaking evidence and disposal document.']
  ],
  'cuprins-carte-cap37.json': [
    [['blocuri', 4, 'text'], 'The organising principle is that returns are not independent. D394 covers the same reporting period as D300 and must reconcile to it, but has a distinct deadline: the 30th day, inclusive, of the month following the reporting period, or 28/29 February for January. D406 contains detailed data that must agree with the accounting and tax records. Annual financial statements reconcile to the final trial balance and the returns filed for the relevant periods.'],
    [['blocuri', 16, 'titlu'], 'For the accountant'],
    [['blocuri', 16, 'text'], 'Filing deadlines derive from the Fiscal Procedure Code and the order governing each form; the 25th is common, not universal. D394, for example, is due on the 30th day of the following month, subject to the 28/29 February rule for January, while D406 and annual financial statements have their own calendars. Four practical points follow. First, non-filing and late filing are penalised separately from non-payment, and a filing obligation may exist even for zero amounts. Second, verify the correction route form by form: D112 permits an amended return; D394 is replaced with a correct return; D100 is corrected through D710; and D300 does not permit an amended VAT return, but uses a subsequent adjustment or the material-error procedure according to the cause. Third, the tax vector must reflect the actual situation and the taxpayer must update it; employees trigger D112, not automatically D205, which covers the income and withholding categories specified by its instructions. Fourth, tax liabilities are settled in the statutory order rather than according to the payer’s informal intention; reconcile the taxpayer account after filing and payment.']
  ],
  'cuprins-carte-cap36.json': [
    [['blocuri', 9, 'text'], 'The scheme is optional and has its own threshold, distinct from the small-enterprise exemption threshold: 5.000.000 lei for 1 March–31 December 2026, increasing to 5.500.000 lei from 1 January 2027. Entry, exit and threshold crossings are notified, and actual application is verified in ANAF’s public register; an internal setting that disagrees with the register does not change chargeability for counterparties.']
  ],
  'cuprins-carte-cap39.json': [
    [['blocuri', 17, 'text'], 'The sequence above follows dependencies between tasks rather than one specific rule, but supports distinct legal obligations: preparing a trial balance at least monthly, preparing and filing returns on time, and retaining documents that evidence transactions. Three practical points follow. First, perform cross-checks — VAT journals to movements in accounts 4426 and 4427, payroll accounts to D112, and third-party balances to receivable/payable schedules — between steps 3 and 4, not after filing. A late cross-check requires the correction procedure specific to the form, and D300 does not accept an ordinary amended return. Second, for companies using the cash-accounting VAT scheme, bank matching is a substantive input to chargeability, not merely a cash control; step 2 must therefore precede step 3. Third, assemble the monthly file — trial balance, journals, returns and receipts, adjustment entries and approval decisions — at closing rather than reconstructing it during an inspection. Later reconstruction tends to omit precisely the evidence that should have supported the judgments.']
  ],
  'cuprins-carte-cap42.json': [
    [['blocuri', 33, 'randuri', 0, 2], 'reperform the closing and verify zero balances in classes 6/7']
  ],
  'cuprins-carte-cap43.json': [
    [['blocuri', 36, 'titlu'], 'Taxable result'],
    [['blocuri', 36, 'randuri', 3, 0], '= Taxable result'],
    [['blocuri', 36, 'nota'], 'The sponsorship expense is first added back in determining the taxable result; its benefit arises later as an amount deducted from corporate income tax. Without the legal reserve, tax would have been 26.392 lei — 960 lei higher.'],
    [['blocuri', 40, 'text'], 'Final tax is 25.432 minus 3.750, or 21.682 lei. The 10.000 lei sponsorship cost the company 6.250 lei in the current year; the balance was absorbed by tax that no longer had to be paid. Report the beneficiary and amounts in D107. Had the company not used the entire ceiling, the available amount could have been redirected through D177 under Article 42 of the Tax Code.'],
    [['blocuri', 42, 'text'], 'Research and development in 2026: enhanced deduction or tax credit'],
    [['blocuri', 43, 'text'], 'For eligible research and development activities, 2026 introduced a choice with a material effect: a corporate income tax payer may apply the incentive based on the enhanced deduction for eligible expenditure or elect the 10% tax credit governed by Article 20^1 of the Tax Code. The two mechanisms cannot be applied to the same eligible expenditure.'],
    [['blocuri', 44, 'titlu'], 'Tax election for an R&D project'],
    [['blocuri', 44, 'cap', 1], 'Enhanced deduction'],
    [['blocuri', 44, 'cap', 2], '10% tax credit'],
    [['blocuri', 44, 'randuri', 0, 0], 'Where the benefit arises'],
    [['blocuri', 44, 'randuri', 0, 1], 'in determining the taxable result'],
    [['blocuri', 44, 'randuri', 0, 2], 'after calculating corporate income tax'],
    [['blocuri', 44, 'randuri', 1, 1], 'eligible, identifiable and documented project and expenditure'],
    [['blocuri', 44, 'randuri', 1, 2], 'the same condition; a percentage cannot cure missing technical documentation'],
    [['blocuri', 44, 'randuri', 2, 1], 'the effective tax saving under the entity’s scenario'],
    [['blocuri', 44, 'randuri', 2, 2], '10% of eligible expenditure, subject to the statutory limits and mechanism'],
    [['blocuri', 44, 'randuri', 3, 0], 'Unused amount'],
    [['blocuri', 44, 'randuri', 3, 1], 'follows the rules for the selected mechanism and the taxable result'],
    [['blocuri', 44, 'randuri', 3, 2], 'offset or refunded under the law within the four-year period'],
    [['blocuri', 44, 'nota'], 'Model the election before finalising D101 and approve it in the tax file. Do not decide from the apparently higher percentage; consider the actual tax position, carried-forward tax losses, other tax credits and capacity to use the benefit.'],
    [['blocuri', 45, 'text'], 'The file begins with the technical owner, not accounting: project objective, novelty, technological uncertainty, activities and people involved, timesheets or time allocations, materials consumed and the criterion separating the work from ordinary commercial activity. Accounting then bridges those records to the expense accounts. A trial-balance subledger labelled “R&D” does not, by itself, establish eligibility.'],
    [['blocuri', 46, 'titlu'], 'R&D election schedule'],
    [['blocuri', 46, 'text'], 'The 2026 working paper contains at least: projects and periods; legal basis and technical eligibility assessment; reconciliation of eligible expenditure to the trial balance and source documents; exclusion of commercial, administrative or incompatibly funded costs; separate modelling of the enhanced deduction and 10% credit; the effect of tax losses and other credits; the approved election; and links to the tax records register and D101. Do not claim both incentives on the same base. Track every carry-forward, offsettable or refundable amount separately by year of origin, deadline and supporting evidence.'],
    [['blocuri', 48, 'puncte', 6], 'From 2026, document the choice between the enhanced deduction and the 10% tax credit for eligible R&D expenditure; the two cannot be combined on the same base.']
  ],
  'cuprins-carte-cap44.json': [
    [['blocuri', 20, 'titlu'], 'For the accountant'],
    [['blocuri', 20, 'text'], 'Profit is appropriated under the accounting regulations and the shareholders’ resolution. The legal reserve is mandatory under Company Law and deductible within the limits of Article 26 of the Tax Code. From 2026, the distribution file must support six tests. First, the reserve is 5% of gross profit until it reaches 20% of subscribed and paid-in capital. Second, dividend tax is 16% for distributions from 1 January 2026, including the rule for dividends distributed but unpaid at year-end. Third, interim dividends are settled against the annual financial statements and any excess is repaid. Fourth, current profit is distributed only after covering retained losses and establishing legal and statutory reserves. Fifth, when net assets are below half of subscribed share capital, annual or interim dividends may be paid only after net assets are restored. Sixth, a company making quarterly distributions may not lend to shareholders or other related parties until differences are settled; breach of the rules introduced by Law 239/2025 may trigger joint liability and fines.'],
    [['blocuri', 33, 'text'], 'Distribution tests applicable in 2026'],
    [['blocuri', 34, 'cap', 1], 'Minimum evidence'],
    [['blocuri', 34, 'cap', 2], 'Conclusion that blocks payment'],
    [['blocuri', 34, 'randuri', 0, 1], 'approved financial statements, trial balance, shareholders’ resolution and reserve calculation'],
    [['blocuri', 34, 'randuri', 0, 2], 'retained loss or reserves not established'],
    [['blocuri', 34, 'randuri', 1, 0], 'Net assets'],
    [['blocuri', 34, 'randuri', 1, 1], 'total assets minus total liabilities, reconciled to the approved financial statements'],
    [['blocuri', 34, 'randuri', 1, 2], 'net assets below half of subscribed capital'],
    [['blocuri', 34, 'randuri', 2, 0], 'Interim dividends'],
    [['blocuri', 34, 'randuri', 2, 1], 'interim financial statements and settlement calculation'],
    [['blocuri', 34, 'randuri', 2, 2], 'prior differences still unsettled'],
    [['blocuri', 34, 'randuri', 3, 0], 'Related-party loans'],
    [['blocuri', 34, 'randuri', 3, 1], 'account 451/455 ledgers, contracts, maturities and confirmations'],
    [['blocuri', 34, 'randuri', 3, 2], 'loan granted to a related party during the restricted period'],
    [['blocuri', 34, 'randuri', 4, 0], 'Withholding tax'],
    [['blocuri', 34, 'randuri', 4, 1], '16% calculation, payment order, D100 and records by beneficiary'],
    [['blocuri', 34, 'randuri', 4, 2], 'net payment with no withholding or no scheduled tax deadline'],
    [['blocuri', 34, 'nota'], 'The tests are cumulative. Cash in the bank does not prove the existence of distributable profit or that net assets permit payment.'],
    [['blocuri', 35, 'text'], 'Law 239/2025 also introduced new minimum share-capital thresholds for SRLs: 500 lei for newly incorporated companies and at least 5.000 lei when reported net turnover exceeds 400.000 lei. Existing companies have the statutory transition period to comply, while companies increasing capital by 31 December 2026 benefit from a reduced publication fee. Keep this control in the same file because capital affects both the net-assets limit and the legal-reserve ceiling.']
  ],
  'cuprins-carte-cap52.json': [
    [['titlu'], 'Accounting policies, estimates, errors and materiality'],
    [['blocuri', 0, 'text'], 'The same 40.000 lei difference can represent three entirely different matters: a new accounting policy, a revised estimate or a prior-period error. The amount is identical; the treatment, affected period, account and note disclosure are not. Professional judgment begins with diagnosing the nature of the change, not with choosing debits and credits.'],
    [['blocuri', 1, 'text'], 'Classify the issue correctly before selecting the journal entry. Flawless bookkeeping applied to a wrong classification still produces misstated financial statements.'],
    [['blocuri', 3, 'randuri', 0, 1], 'sets the mandatory treatment and the permitted options'],
    [['blocuri', 3, 'randuri', 1, 1], 'selects consistently among permitted options and defines thresholds'],
    [['blocuri', 3, 'randuri', 2, 1], 'defines who applies the policy, when, using which evidence and subject to which control'],
    [['blocuri', 3, 'randuri', 3, 1], 'translates the decision into accounts, useful lives, rates and automated rules'],
    [['blocuri', 3, 'randuri', 4, 0], 'Posting'],
    [['blocuri', 3, 'randuri', 4, 1], 'records the effect of a specific transaction'],
    [['blocuri', 3, 'randuri', 4, 2], 'supporting document, calculation and journal entry'],
    [['blocuri', 3, 'nota'], 'A software parameter is not an accounting policy. It merely implements a policy that must exist, be approved and remain explainable without access to the software.'],
    [['blocuri', 5, 'randuri', 0, 2], 'only when required by regulation or when the new policy provides more reliable and relevant information; apply and disclose it under the relevant rules'],
    [['blocuri', 5, 'randuri', 1, 1], 'was the original information reasonable, with new data or circumstances arising later?'],
    [['blocuri', 5, 'randuri', 1, 2], 'prospectively, in profit or loss for the period of change and, where applicable, future periods'],
    [['blocuri', 5, 'randuri', 2, 2], 'correct under the entity’s materiality policy; material prior-period errors are corrected through retained earnings'],
    [['blocuri', 5, 'randuri', 3, 1], 'did the economic event arise now rather than exist at the previous reporting date?'],
    [['blocuri', 5, 'nota'], 'The best indicator is the quality of the information available when the original decision was made. An estimate that later proves inaccurate does not automatically become an error.'],
    [['blocuri', 7, 'text'], 'Accounting policies must produce a true and fair view under the applicable accounting regulations; tax rules determine the taxable base. The values may coincide, but that does not merge the two calculations. An item may qualify as a fixed asset for accounting purposes because of its nature, use and the entity’s capitalisation policy, even when its value is below the 5.000 lei tax threshold applicable from 2026. Track the difference in the tax records register; do not “solve” it by distorting the accounting classification.'],
    [['blocuri', 8, 'titlu'], 'Three files supporting the same decision'],
    [['blocuri', 8, 'randuri', 0, 1], 'which treatment faithfully reflects the transaction, and which policy applies?'],
    [['blocuri', 8, 'randuri', 0, 2], 'equipment recognised as an asset; 36-month useful life; zero residual value'],
    [['blocuri', 8, 'randuri', 1, 2], 'tax treatment tracked separately, with authority documented and the difference reconciled'],
    [['blocuri', 10, 'text'], 'Information is material when omitting or misstating it could influence users’ decisions. Size is only the first measure. Nature can make a small amount material: a transaction with a director, a covenant breach, turning a loss into profit, concealing fraud, crossing a tax threshold or affecting the right to distribute dividends.'],
    [['blocuri', 11, 'titlu'], 'Materiality assessment'],
    [['blocuri', 11, 'cap', 2], 'Review warning'],
    [['blocuri', 11, 'randuri', 0, 0], 'Quantitative'],
    [['blocuri', 11, 'randuri', 0, 1], 'appropriate benchmarks — revenue, assets, profit or loss, equity — plus the percentage and rationale'],
    [['blocuri', 11, 'randuri', 1, 1], 'related parties, compliance, fraud, management remuneration, covenants and statutory thresholds'],
    [['blocuri', 11, 'randuri', 2, 0], 'Individual and aggregate'],
    [['blocuri', 11, 'nota'], 'Set the threshold before the review and reassess it when actual results differ substantially from expectations. Do not invent it after discovering an error.'],
    [['blocuri', 13, 'text'], 'Under OMFP No. 1.802/2014, material prior-period errors are corrected through retained earnings, using account 1174. Immaterial errors may be corrected through current-period profit or loss when the entity’s policy consistently provides for that treatment. Financial statements already approved and filed are not rewritten in the accounting records; the nature and effect of the correction are disclosed where required. Any affected tax returns are assessed separately and amended when necessary.'],
    [['blocuri', 14, 'text'], 'Account 1174 is not a catch-all for old problems. Use it only after demonstrating that an error exists, belongs to a prior period and is material under the documented policy.'],
    [['blocuri', 15, 'text'], 'Professional judgment memorandum'],
    [['blocuri', 16, 'cap', 1], 'What another reviewer must be able to reconstruct'],
    [['blocuri', 16, 'randuri', 5, 0], 'Follow-up'],
    [['blocuri', 16, 'randuri', 5, 1], 'recalculation, amended returns, disclosures, future adjustments and deadline'],
    [['blocuri', 17, 'titlu'], 'For the accountant'],
    [['blocuri', 17, 'text'], 'Tailor the accounting policies manual to the entity’s actual operations; do not copy it wholesale from another entity. For every area involving a choice or estimate — inventories, capitalisation, depreciation, receivables, provisions, foreign exchange and materiality — document the owner, data source, review frequency and control. Support an estimate change with new information and apply it prospectively. Prove an error using information that existed and could have been used at the original date. Justify a policy change by a new requirement or by more reliable and relevant information. After every correction, reconcile the trial balance, financial statements, tax records register and returns; an accounting correction does not automatically amend the tax obligation.'],
    [['blocuri', 18, 'enunt', 0], 'At 31 December 2026, three situations arise: (a) the remaining useful life of a machine is shortened because new technical data indicate lower expected production; (b) a material November 2025 invoice, received and approved at that time, was not recorded; (c) the entity wants to change its inventory valuation method solely to improve profit.'],
    [['blocuri', 18, 'enunt', 1], 'Classify each situation and identify the supporting document or treatment in principle.'],
    [['blocuri', 18, 'rezolvare', 0], '(a) Change in estimate: the technical information is new. Recalculate depreciation prospectively over the revised remaining useful life and carrying amount; do not restate prior-year depreciation if the former estimate was reasonable.'],
    [['blocuri', 18, 'rezolvare', 1], '(b) Prior-period error: the information existed and was available. Assess materiality individually and in aggregate; if material, correct the accounting records through retained earnings and assess the tax effect and any amended returns separately.'],
    [['blocuri', 18, 'rezolvare', 2], '(c) The policy change is not justified. A desire to alter profit does not produce more reliable and relevant information and breaches consistency; retain the existing method.'],
    [['blocuri', 18, 'rezolvare', 3], 'The file contains the chronology, information available at each date, materiality assessment, authority, rejected alternative, effect calculation and approval.'],
    [['blocuri', 20, 'puncte', 0], 'A policy selects and applies an accounting basis; an estimate measures an uncertain amount; an error misuses information that already existed.'],
    [['blocuri', 20, 'puncte', 3], 'Keep the accounting and tax analyses distinct and reconcile their effects; never subordinate the true and fair view to a tax advantage.']
  ],
  'cuprins-carte-cap53.json': [
    [['titlu'], 'Provisions, subsequent events and going concern'],
    [['blocuri', 0, 'text'], 'Year-end closing is not limited to counting items that exist. It also requires recognising obligations that do not yet have an invoice, final amount or certain due date, and using information arising after 31 December to understand the conditions that actually existed at 31 December.'],
    [['blocuri', 1, 'text'], 'Uncertainty is not a reason to omit an item. It is a reason to identify the obligation, assess the probability of an outflow and develop the best supportable estimate.'],
    [['blocuri', 3, 'randuri', 0, 1], 'continue the assessment'],
    [['blocuri', 3, 'randuri', 1, 1], 'continue the recognition assessment'],
    [['blocuri', 3, 'randuri', 1, 2], 'consider disclosure as a contingent liability unless the possibility is remote'],
    [['blocuri', 3, 'randuri', 2, 1], 'recognise a provision at the best estimate'],
    [['blocuri', 3, 'randuri', 2, 2], 'rare case: disclose the nature and the inability to estimate where disclosure is required'],
    [['blocuri', 3, 'randuri', 3, 0], 'Is the risk remote?'],
    [['blocuri', 3, 'randuri', 3, 2], 'otherwise disclose the nature, uncertainties and estimable financial effect'],
    [['blocuri', 4, 'text'], 'Estimating a provision'],
    [['blocuri', 6, 'cap', 0], 'Scenario'],
    [['blocuri', 6, 'cap', 2], 'Estimated cost'],
    [['blocuri', 6, 'nota'], 'The calculation is only the numerical result. The file must also support the sales population, defect history, product changes and approval of the assumptions.'],
    [['blocuri', 7, 'text'], 'Review provisions at each balance-sheet date and adjust them to the current estimate. Reverse a provision to income when an outflow is no longer probable. Use it only for the obligation for which it was recognised; it is not a reserve for smoothing profit between years.'],
    [['blocuri', 9, 'text'], 'The period between the balance-sheet date and the date the financial statements are authorised for issue is not informationally closed. Classify events arising in that interval by what they evidence: conditions existing at the balance-sheet date or conditions arising afterwards.'],
    [['blocuri', 10, 'titlu'], 'Adjusting event or disclosure only'],
    [['blocuri', 10, 'randuri', 0, 1], 'confirms impairment of the receivable existing at the balance-sheet date'],
    [['blocuri', 10, 'randuri', 0, 2], 'adjust the receivable at 31 December'],
    [['blocuri', 10, 'randuri', 1, 1], 'clarifies the amount of a present obligation'],
    [['blocuri', 10, 'randuri', 1, 2], 'adjust the provision or recognise the liability'],
    [['blocuri', 10, 'randuri', 2, 1], 'creates a new condition after the balance-sheet date'],
    [['blocuri', 10, 'randuri', 3, 2], 'disclose if material, without retrospective recognition'],
    [['blocuri', 10, 'nota'], 'The invoice, judgment or payment date does not determine the treatment on its own. The decisive question is which condition existed at the balance-sheet date.'],
    [['blocuri', 12, 'text'], 'A professional does not wait for events to reach accounting by chance. Send written enquiries to management, legal counsel, sales and treasury; inspect subsequent receipts and payments, minutes of governing bodies, new contracts, notices, court portals and lender correspondence. Record the event, date identified, condition existing at year-end, adjusting/non-adjusting conclusion, amount and disclosure.'],
    [['blocuri', 14, 'text'], 'Financial statements are normally prepared on a going-concern basis. That basis is no longer appropriate when the governing bodies decide to liquidate or cease operations, or when no realistic alternative exists. Uncertainties that may cast significant doubt must be assessed and clearly disclosed. The director’s declaration required by the Accounting Law does not replace its supporting analysis.'],
    [['blocuri', 15, 'titlu'], 'Going-concern file'],
    [['blocuri', 15, 'cap', 1], 'Evidence'],
    [['blocuri', 15, 'randuri', 1, 2], 'breaches, concentrated maturities and non-binding sources assessed separately'],
    [['blocuri', 15, 'randuri', 3, 1], 'litigation, enforcement, overdue liabilities, inspections and payment arrangements'],
    [['blocuri', 15, 'randuri', 5, 0], 'Subsequent events'],
    [['blocuri', 15, 'randuri', 5, 2], 'confirm or contradict the forecast assumptions'],
    [['blocuri', 15, 'nota'], 'A promise of a capital contribution is not available cash unless supported by a resolution, identified funds and demonstrated financial capacity.'],
    [['blocuri', 17, 'text'], 'Start the cash-flow forecast from reconciled bank balances and receivables and liabilities by due date, not from the annual income budget. Use approved assumptions for the base case. A severe but plausible case delays receipts, reduces sales or removes uncertain funding. For every shortfall, state the response, date, owner, amount and whether the action is under the entity’s control. Conclude whether a material uncertainty exists and which disclosure is required.'],
    [['blocuri', 18, 'titlu'], 'For the accountant'],
    [['blocuri', 18, 'text'], 'At closing, obtain evidence beyond the accounting records: the lawyer’s letter, warranty data, complaints, onerous contracts, announced restructuring decisions, environmental obligations and minutes of management meetings. Reconcile each provision from opening balance through additions, utilisation and reversals to closing balance; document tax deductibility separately because it does not determine accounting recognition. Maintain the subsequent-events register until the statements are authorised. For going concern, retain the forecast, sources for assumptions, sensitivity tests, approved plans, subsequent actual results and minutes of the discussion with the director. A generic note cannot cure a missing analysis.'],
    [['blocuri', 19, 'enunt', 0], 'At 31 December, the company is party to litigation begun in June. Counsel estimated a probable loss of between 80.000 and 120.000 lei. In February, the court issues a final award of 105.000 lei. Also in February, a major customer enters insolvency; at 31 December its balance had been overdue for 150 days and negotiations had failed. Paying the 105.000 lei creates an April cash shortfall.'],
    [['blocuri', 19, 'enunt', 1], 'Determine the effects on the 31 December financial statements and the going-concern file.'],
    [['blocuri', 19, 'rezolvare', 0], 'The February judgment confirms the obligation existing at 31 December. Adjust the provision to 105.000 lei and document the legal information and the date the financial statements are authorised.'],
    [['blocuri', 19, 'rezolvare', 1], 'The customer’s insolvency confirms impairment indicators existing at 31 December. Estimate recoverable value and adjust the receivable; the later opening of proceedings does not turn the pre-existing condition into a new event.'],
    [['blocuri', 19, 'rezolvare', 3], 'The going-concern conclusion does not follow automatically from the shortfall. It depends on its scale and duration, committed funding, controllable actions and adequate disclosure of uncertainties.'],
    [['blocuri', 21, 'puncte', 0], 'A provision requires a present obligation from a past event, a probable outflow and a reliable estimate.'],
    [['blocuri', 21, 'puncte', 1], 'Review a provision and use it only for its original purpose; it is not a profit-smoothing instrument.'],
    [['blocuri', 21, 'puncte', 2], 'A subsequent event adjusts the statements when it evidences a condition existing at year-end; a new condition may require disclosure only.'],
    [['blocuri', 21, 'puncte', 3], 'Support going concern with cash flows, maturities, sensitivities and feasible plans, not a generic declaration.'],
    [['blocuri', 21, 'puncte', 4], 'Document accounting treatment and tax deductibility separately.']
  ],
  'cuprins-carte-cap54.json': [
    [['titlu'], 'Related parties, shareholders, capital and financing'],
    [['blocuri', 0, 'text'], 'Cash moving between a company and its shareholders looks like any other cash in the bank statement. In substance it may be capital, a loan, a dividend, an expense advance, a reimbursement or an unsupported withdrawal. Each classification changes the rights, risk, maturity, tax and sometimes the legality of the payment.'],
    [['blocuri', 1, 'text'], 'The shareholder relationship is not a supporting document. “Money paid in” and “money taken out” describe the movement; the contract, resolution and economic substance determine its accounting nature.'],
    [['blocuri', 2, 'text'], 'First: map the related parties'],
    [['blocuri', 3, 'text'], 'Identification is not limited to direct shareholders. Map direct and indirect control, joint control, significant influence, directors and key management, relevant relatives and entities they control, as well as linked enterprises under tax legislation. Accounting, tax and company-law definitions do not perfectly overlap; apply the definition in the instrument requiring each test.'],
    [['blocuri', 4, 'randuri', 1, 2], 'articles of association, resolutions, contracts and effective entry/exit dates'],
    [['blocuri', 4, 'randuri', 2, 2], 'subledgers by counterparty, confirmations and intragroup reconciliation'],
    [['blocuri', 4, 'randuri', 4, 0], 'Approvals and conflicts'],
    [['blocuri', 4, 'randuri', 4, 1], 'demonstrates governance over the transaction'],
    [['blocuri', 4, 'randuri', 4, 2], 'shareholders’/directors’ resolutions and declarations of interest'],
    [['blocuri', 6, 'titlu'], 'Substance of shareholder financing'],
    [['blocuri', 6, 'randuri', 0, 0], 'Right to repayment'],
    [['blocuri', 6, 'randuri', 0, 1], 'no ordinary maturity; repayment follows capital-reduction procedures'],
    [['blocuri', 6, 'randuri', 1, 1], 'dividend only from distributable profit and after a valid resolution'],
    [['blocuri', 6, 'randuri', 1, 2], 'interest when contractually agreed and legally and fiscally supportable'],
    [['blocuri', 6, 'randuri', 2, 1], 'absorbs losses first'],
    [['blocuri', 6, 'randuri', 2, 2], 'a shareholder receivable that may become subordinated or legally/contractually restricted'],
    [['blocuri', 6, 'randuri', 3, 1], 'resolution, amended constitutional document, subscription and payment'],
    [['blocuri', 6, 'randuri', 4, 0], 'Common accounts'],
    [['blocuri', 6, 'randuri', 4, 2], '4551 principal and 4558 interest, with separate subledgers'],
    [['blocuri', 6, 'nota'], 'The label used by the parties is evidence, not the conclusion. Financing with no contract, maturity and a perpetually rolled balance requires a fresh assessment of substance and presentation.'],
    [['blocuri', 7, 'text'], 'Interest between related parties requires three distinct analyses: accrual accounting over the financing term; arm’s-length pricing and tax documentation; and applicable deductibility limits for borrowing costs. Non-payment does not eliminate accrued expense or income when a contractual obligation exists. Recording interest does not prove that its rate is at arm’s length.'],
    [['blocuri', 8, 'text'], 'Money withdrawn by a shareholder'],
    [['blocuri', 9, 'titlu'], 'Classifying the withdrawal'],
    [['blocuri', 9, 'randuri', 1, 1], 'account 457 and payment/set-off, with the related tax and returns'],
    [['blocuri', 9, 'randuri', 1, 2], 'payment before a resolution or in excess of distributable profit'],
    [['blocuri', 9, 'randuri', 3, 1], 'the corresponding income treatment and payroll/tax obligations'],
    [['blocuri', 9, 'randuri', 3, 2], 'recurring payments labelled as “advances”'],
    [['blocuri', 9, 'randuri', 4, 1], 'recognise a clearly identified receivable and escalate it to management; do not conceal it in cash or expenses'],
    [['blocuri', 11, 'text'], 'A shareholders’ resolution cannot make an amount distributable when the law prohibits distribution. Before declaring a dividend, verify determined and approved profit, lawful loss coverage, reserves, net assets, contractual restrictions and interim-dividend status. The dividend tax is 16% for distributions governed by the regime effective from 1 January 2026, but the rate is only one of the tests.'],
    [['blocuri', 12, 'randuri', 0, 2], 'resolutions, payments, balances in accounts 455/461 and annual settlement'],
    [['blocuri', 12, 'randuri', 1, 0], 'Net assets below half of subscribed share capital'],
    [['blocuri', 12, 'randuri', 1, 1], 'dividends and repayments of shareholder/related-party loans are restricted until net assets are restored, under the applicable rules'],
    [['blocuri', 12, 'randuri', 1, 2], 'net-assets calculation, subscribed capital, resolutions and subsequent payments'],
    [['blocuri', 12, 'randuri', 2, 1], 'plan the increase within the deadline; do not cosmetically inflate equity through set-offs lacking due process'],
    [['blocuri', 12, 'randuri', 2, 2], 'turnover, articles of association, paid-in capital and compliance timetable'],
    [['blocuri', 13, 'text'], 'For newly incorporated SRLs, minimum share capital is 500 lei. For limited-liability companies whose turnover exceeds 400.000 lei, the minimum is 5.000 lei, subject to the application and transition rules in Law No. 239/2025. Treat these as volatile statutory parameters: verify them before each decision rather than copying the prior-year file.'],
    [['blocuri', 15, 'text'], 'Confirm related-party balances bilaterally by currency, document and nature. Break differences down into in-transit transactions, exchange rates, one-sided invoices, set-offs, interest and classification differences. Agreement on the amount does not prove correct classification: one entity may show a loan while the other shows an advance, with totals agreeing perfectly.'],
    [['blocuri', 16, 'randuri', 0, 1], 'beneficial owner, control, period and relevant definitions'],
    [['blocuri', 16, 'randuri', 1, 0], 'Movements and balance'],
    [['blocuri', 16, 'randuri', 4, 0], 'Disclosure and tax'],
    [['blocuri', 16, 'randuri', 4, 1], 'notes, returns, transfer pricing, withholding tax and deductibility, as applicable'],
    [['blocuri', 17, 'titlu'], 'For the accountant'],
    [['blocuri', 17, 'text'], 'Maintain separate subledgers for every shareholder and nature: subscribed/paid-in capital, loan principal, interest, dividends, advances and other receivables. Do not offset balances merely because they concern the same person; set-off requires a documented right and intention. Update the related-party map annually and obtain management’s completeness representation. Establish the basis for every shareholder payment before payment, not at year-end. Calculate and retain net assets before dividends and financing repayments; verify the restrictions in Law No. 239/2025, interim-dividend settlement, arm’s-length terms and tax effects. Present a related-party transaction according to substance even when the trial balance is closed and both parties confirm the amount.'],
    [['blocuri', 18, 'titlu'], 'Exercise 54.1 — the shareholder requests 200.000 lei'],
    [['blocuri', 18, 'enunt', 0], 'The company distributed interim dividends in September 2026. In November, the shareholder requests repayment of an old 200.000 lei loan plus another 50.000 lei “until next month”. In the latest trial balance, net assets are below half of subscribed share capital. No contract exists for the 50.000 lei.'],
    [['blocuri', 18, 'rezolvare', 2], 'For the 50.000 lei, establish the proposed nature of the transfer. After interim dividends have been distributed, granting a loan to a shareholder or related party before settlement is subject to the statutory restriction; the contract, approval and terms are also missing.'],
    [['blocuri', 18, 'rezolvare', 3], 'The file contains the net-assets calculation, dividend resolutions, settlement status, account 455 ledger, old contract, legal and tax analyses and written communication to the director. Do not use account 542 or the cash account to bypass the conclusion.'],
    [['blocuri', 20, 'puncte', 0], 'Build the related-party map from control and substance, not only the list of direct shareholders.'],
    [['blocuri', 20, 'puncte', 1], 'Capital, loans, dividends, advances and remuneration create different rights and require different evidence; a bank statement does not classify them.'],
    [['blocuri', 20, 'puncte', 4], 'Accounting treatment, company-law validity, arm’s-length pricing and tax effect are four distinct tests.']
  ],
  'cuprins-carte-cap55.json': [
    [['titlu'], 'Working papers and professional review'],
    [['blocuri', 0, 'text'], 'A trial balance can be correct even when nobody can still explain why. Working papers turn the result from a collection of files into a chain of assertions, evidence, procedures and conclusions that another professional can reperform.'],
    [['blocuri', 2, 'text'], 'Assertions: what a figure actually states'],
    [['blocuri', 3, 'titlu'], 'Assertions used in a review'],
    [['blocuri', 3, 'randuri', 1, 0], 'Completeness'],
    [['blocuri', 3, 'randuri', 1, 2], 'search for unrecorded liabilities, sequence tests and subsequent payments'],
    [['blocuri', 3, 'randuri', 3, 0], 'Valuation and allocation'],
    [['blocuri', 3, 'randuri', 3, 1], 'are the amount, estimate, exchange rate and adjustment correct?'],
    [['blocuri', 3, 'randuri', 3, 2], 'recalculation, ageing, recoverability and external sources'],
    [['blocuri', 3, 'randuri', 4, 2], 'documents immediately before and after closing, goods receipts and dispatch records'],
    [['blocuri', 3, 'randuri', 5, 2], 'contract, mapping to the reporting form and disclosure checklist'],
    [['blocuri', 3, 'randuri', 6, 2], 'recalculation and agreement to source'],
    [['blocuri', 3, 'nota'], 'Design the procedure around the assertion. A customer confirmation tests existence of the receivable well, but provides little evidence about completeness of supplier liabilities.'],
    [['blocuri', 5, 'randuri', 0, 1], 'accounts, movements, number of items, currencies and locations'],
    [['blocuri', 5, 'randuri', 3, 0], 'Assertion at risk'],
    [['blocuri', 5, 'randuri', 4, 1], 'procedure, selection, period, owner and expected evidence'],
    [['blocuri', 5, 'nota'], 'A large balance does not automatically mean high risk, and a zero balance may carry a high completeness risk. Planning is not a descending sort of the trial balance.'],
    [['blocuri', 7, 'text'], 'Financial-statement materiality defines what could influence a user. Performance materiality is lower, reducing the risk that undetected and uncorrected misstatements together exceed the final threshold. Also set a clearly trivial level, but never use it to dismiss qualitative errors, fraud or related-party transactions.'],
    [['blocuri', 8, 'randuri', 0, 0], 'Fact and cause'],
    [['blocuri', 8, 'randuri', 1, 0], 'Known/projected amount'],
    [['blocuri', 8, 'randuri', 4, 1], 'has the journal entry been posted, verified and propagated to every deliverable?'],
    [['blocuri', 9, 'text'], 'Evidence: sufficient and appropriate'],
    [['blocuri', 10, 'text'], 'Sufficiency concerns quantity; appropriateness concerns relevance and reliability. One hundred copies of internal invoices do not compensate for missing evidence that a service was performed. Evidence obtained directly from an independent source is generally more reliable than an oral explanation; a controlled original is stronger than a file of unknown provenance; documentary evidence is easier to verify than memory. No hierarchy is absolute: the procedure must address the assertion.'],
    [['blocuri', 11, 'titlu'], 'What makes a self-contained working paper'],
    [['blocuri', 11, 'randuri', 1, 1], 'identify the exact report, extraction date, parameters and data owner'],
    [['blocuri', 11, 'randuri', 2, 0], 'Link to the trial balance'],
    [['blocuri', 11, 'randuri', 2, 1], 'reconcile the working-paper total to the account and explain every difference'],
    [['blocuri', 11, 'randuri', 6, 1], 'answer the objective and identify required adjustments or disclosures'],
    [['blocuri', 11, 'randuri', 7, 0], 'Preparation and review'],
    [['blocuri', 13, 'text'], 'Selection does not begin with “the first ten invoices”. Define the complete population and the purpose of the test. Test all individually material or specifically risky items. Select the remainder randomly, systematically or by risk, but limit the conclusion to what the method supports. A selection aimed only at exceptions may find problems, but it cannot support a statistical conclusion about the entire population.'],
    [['blocuri', 14, 'randuri', 0, 1], '100% testing, confirmation or alternative procedures'],
    [['blocuri', 14, 'randuri', 1, 0], 'Debit, unusual and related-party balances'],
    [['blocuri', 14, 'randuri', 1, 1], 'testing directed at nature, classification and recoverability'],
    [['blocuri', 14, 'randuri', 2, 1], 'representative selection linked to the objective and performance materiality'],
    [['blocuri', 15, 'text'], 'Review: the preparer cannot see every assumption they made'],
    [['blocuri', 16, 'text'], 'The reviewer assesses the objective, source, link to the trial balance, logic of the procedure, conclusion and propagation of adjustments. The reviewer need not mechanically repeat every step, but examines judgmental areas, estimates, exceptions, unusual transactions and changes from the prior year in greater depth. A review note remains open until the response is evidenced and its effect followed through; “discussed” is not a resolution.'],
    [['blocuri', 17, 'titlu'], 'Annual-file pyramid'],
    [['blocuri', 17, 'randuri', 0, 1], 'signed deliverables and filing receipts'],
    [['blocuri', 17, 'randuri', 0, 2], 'each line cross-references to a lead schedule'],
    [['blocuri', 17, 'randuri', 1, 0], 'Lead schedules'],
    [['blocuri', 17, 'randuri', 1, 1], 'balances by caption, movements, comparisons and conclusions'],
    [['blocuri', 17, 'randuri', 1, 2], 'link to the final trial balance and detailed schedules'],
    [['blocuri', 17, 'randuri', 2, 2], 'identify the supporting evidence'],
    [['blocuri', 19, 'text'], 'Before signing, verify that the final trial balance is the one used in every deliverable, all approved adjustments are posted, uncorrected differences are aggregated, disclosures are complete, subsequent events are updated and management’s representation addresses the actual issues. After filing, logically lock the file: later additions identify author, date and reason without deleting the original trail.'],
    [['blocuri', 20, 'titlu'], 'For the accountant'],
    [['blocuri', 20, 'text'], 'Index the permanent file separately from the current-year file. The permanent file contains constitutional documents, long-term contracts, policies and systems descriptions; the annual file contains the trial balance, lead schedules, tests, estimates, tax work, financial statements and filing receipts. Each paper states its objective, assertion, source, procedure, result, conclusion, preparer and reviewer. Link financial-statement lines to the trial balance and returns to their registers. Record all differences, including corrected ones, to reveal systemic errors. Maintain one open-points list and do not sign while a material point lacks evidence, adjustment or an approved conclusion.'],
    [['blocuri', 21, 'titlu'], 'Exercise 55.1 — designing the receivables review'],
    [['blocuri', 21, 'enunt', 0], 'Trade receivables total 2.400.000 lei across 1.800 items. Two customers account for 900.000 lei; credit balances total 70.000 lei, related-party receivables 250.000 lei and balances older than 180 days 400.000 lei. Performance materiality is 120.000 lei.'],
    [['blocuri', 21, 'enunt', 1], 'Design the review response without calculating a statistical sample size.'],
    [['blocuri', 21, 'rezolvare', 0], 'First reconcile the complete listing to the trial balance and verify the report date and parameters. A selection has no sound basis without a complete population.'],
    [['blocuri', 21, 'rezolvare', 1], 'Test both large customers in full. Analyse credit balances for classification as liabilities or advances. Test related parties separately for existence, terms and disclosure. Test old receivables for valuation and subsequent receipts.'],
    [['blocuri', 21, 'rezolvare', 2], 'Use an appropriate representative selection from the remainder to test existence and accuracy. Design separate procedures over documents around the balance-sheet date for completeness of revenue and cut-off; balance confirmations alone do not address those assertions.'],
    [['blocuri', 21, 'rezolvare', 3], 'Evaluate exceptions individually, project them where the method requires and aggregate them in the differences register. Conclude separately on existence, valuation, classification and presentation.'],
    [['blocuri', 23, 'puncte', 0], 'Begin the review with risk and assertion, not the account and balance size.'],
    [['blocuri', 23, 'puncte', 2], 'A self-contained working paper identifies its source, procedure, selection, exceptions, conclusion, preparer and reviewer.'],
    [['blocuri', 23, 'puncte', 3], 'Aggregate errors qualitatively as well as numerically; a systemic cause requires extending the procedure.'],
    [['blocuri', 23, 'puncte', 4], 'The final file must allow the path from document and judgment to every signed line to be reperformed.']
  ],
  'cuprins-carte-capF.json': [
    [['blocuri', 0, 'text'], 'This edition was verified as at 27 August 2026. The date forms part of the information: tax, electronic reporting, the minimum wage and forms change faster than core accounting treatments. This appendix explains which sources carry authority, which values require reverification and how to update a conclusion without confusing legislation, instructions and the technical operation of a portal.'],
    [['blocuri', 1, 'text'], 'An up-to-date book cannot promise that a figure will remain valid. It states the verification date, source, scope, transition rule and procedure for checking the figure again.'],
    [['blocuri', 3, 'text'], 'The accounting treatments address Romanian entities applying OMFP No. 1.802/2014. IFRS reporters, public institutions, not-for-profit organisations, persons using single-entry bookkeeping and prudentially or specially regulated sectors require their own map. Tax examples target ordinary Romanian companies; non-residence, tax groups, excise duties, customs regimes and complex cross-border transactions require separate analysis.'],
    [['blocuri', 5, 'randuri', 0, 1], 'laws, ordinances, government decisions, orders and their annexes'],
    [['blocuri', 5, 'randuri', 2, 2], 'govern reporting and validations within the authority of the higher-level instrument'],
    [['blocuri', 5, 'randuri', 3, 1], 'ANAF or Ministry of Finance material'],
    [['blocuri', 5, 'randuri', 4, 2], 'evidences technical operation at a particular date; document technical errors separately'],
    [['blocuri', 5, 'randuri', 5, 2], 'initial warning and guidance; return to the official source for the substantive conclusion'],
    [['blocuri', 5, 'nota'], 'When two sources appear to conflict, check the transaction date, effective date, transition rule, scope and legal authority before assuming either source is wrong.'],
    [['blocuri', 7, 'randuri', 2, 0], 'Financial-accounting documents'],
    [['blocuri', 7, 'randuri', 2, 2], 'document register, workflow, numbering and retention period'],
    [['blocuri', 7, 'randuri', 3, 2], 'resolution, committees, lists, confirmations, minutes and accounting for differences'],
    [['blocuri', 7, 'randuri', 5, 2], 'calendar, form version, filing receipt and reconciliation'],
    [['blocuri', 7, 'randuri', 6, 2], 'net-assets calculation, resolutions, restrictions and subsequent payments'],
    [['blocuri', 7, 'randuri', 7, 2], 'dated parameters sheet, payrolls, timesheets and D112'],
    [['blocuri', 9, 'randuri', 0, 1], 'single 1% rate; EUR 100.000 threshold; cumulative conditions and linked enterprises'],
    [['blocuri', 9, 'randuri', 1, 1], '4.325 lei from 1 July 2026'],
    [['blocuri', 9, 'randuri', 1, 2], 'HG No. 146/2026; for every payroll and contractual change'],
    [['blocuri', 9, 'randuri', 2, 0], 'Tax-exempt amount at the minimum wage'],
    [['blocuri', 9, 'randuri', 2, 1], '200 lei in the second half of 2026 when the conditions and 4.600 lei gross-income ceiling are met'],
    [['blocuri', 9, 'randuri', 4, 0], 'Dividend tax'],
    [['blocuri', 9, 'randuri', 4, 1], '16% for the regime applicable from 1 January 2026'],
    [['blocuri', 9, 'randuri', 5, 0], 'Fixed asset for tax purposes'],
    [['blocuri', 9, 'randuri', 5, 1], '5.000 lei threshold from 2026; the tax threshold is not the accounting capitalisation policy'],
    [['blocuri', 9, 'randuri', 5, 2], 'OUG No. 8/2026; when the asset is recognised'],
    [['blocuri', 9, 'randuri', 7, 0], 'Cash-accounting VAT scheme'],
    [['blocuri', 9, 'randuri', 7, 1], '5.000.000 lei threshold for 1 March–31 December 2026; 5.500.000 lei from 2027'],
    [['blocuri', 9, 'randuri', 8, 0], 'RO e-Factura'],
    [['blocuri', 9, 'randuri', 9, 0], 'Correction of D300'],
    [['blocuri', 9, 'randuri', 9, 1], 'no amended VAT return is filed; use adjustments in a subsequent return or the material-error procedure, according to the cause'],
    [['blocuri', 9, 'randuri', 10, 1], '2 June 2026 deadline and electronic filing only'],
    [['blocuri', 9, 'randuri', 10, 2], 'OMF No. 2.036/2025 and the official calendar; annually'],
    [['blocuri', 9, 'randuri', 11, 0], 'Minimum SRL share capital'],
    [['blocuri', 9, 'randuri', 11, 1], '500 lei for new companies; 5.000 lei when turnover exceeds 400.000 lei, subject to the statutory transition'],
    [['blocuri', 9, 'randuri', 11, 2], 'Law No. 239/2025; on incorporation, at annual closing and through 18 December 2027'],
    [['blocuri', 9, 'nota'], 'The table is a checklist, not a substitute for the law. The exact rule depends on the chargeable-event date, taxpayer category and transitional provisions.'],
    [['blocuri', 11, 'randuri', 0, 1], 'monitor a new instrument, form, validator, deadline or incident'],
    [['blocuri', 11, 'randuri', 2, 2], 'scope memorandum'],
    [['blocuri', 11, 'randuri', 3, 1], 'old text versus new text, condition by condition'],
    [['blocuri', 11, 'randuri', 4, 1], 'accounts, policies, contracts, taxes, returns, systems, controls and clients'],
    [['blocuri', 11, 'randuri', 5, 1], 'procedure, parameters, migration, communication and accountable owner'],
    [['blocuri', 11, 'randuri', 6, 1], 'before/after cases, independent recalculation and deliverable verification'],
    [['blocuri', 11, 'randuri', 6, 2], 'test and acceptance evidence'],
    [['blocuri', 11, 'randuri', 7, 1], 'version, reference date, author, reviewer and archival of the old rule'],
    [['blocuri', 13, 'randuri', 0, 1], 'e-Factura deadline: 5 business days'],
    [['blocuri', 13, 'randuri', 1, 0], 'Exact authority'],
    [['blocuri', 13, 'randuri', 4, 1], '“business day” unit, calendar and alert'],
    [['blocuri', 14, 'titlu'], 'For the accountant'],
    [['blocuri', 14, 'text'], 'Maintain a legislative register with an accountable owner for each area, official sources, alerts and periodic review. For every change, distinguish publication date, effective date and the first affected reporting period. Retain the version applicable to the transaction, not only the consolidated text consulted today. Link each rule to the software parameter, procedure, control and communication to the client or management. Test an ordinary transaction, boundary cases and the transition. A form change without a change in law may still require implementation; an official communication may require attention but cannot, on its own, rewrite policy.'],
    [['blocuri', 15, 'titlu'], 'Exercise F.1 — from official communication to a controlled rule'],
    [['blocuri', 15, 'rezolvare', 0], 'Identify and archive the published legal instrument. Verify the article, scope, definition of the base, exchange rate or reference period, effective date and transition; retain the communication as explanatory material.'],
    [['blocuri', 15, 'rezolvare', 1], 'Extract affected clients using the statutory definition, not an approximate report. For each client, simulate the threshold-crossing date and notification or filing obligations.'],
    [['blocuri', 16, 'titlu'], 'Key points from this appendix']
  ]
};

for (const [name, updates] of Object.entries(editorial)) {
  const file = path.join(ROOT, name);
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const [keys, value] of updates) set(json, keys, value);
  fs.writeFileSync(file, `${JSON.stringify(json, null, 1)}\n`);
}

function standardiseTaxTerms(value) {
  if (typeof value === 'string') {
    return value
      .replace(/\bFISCAL results?\b/g, (match) => match.endsWith('s') ? 'TAXABLE results' : 'TAXABLE result')
      .replace(/\bFiscal results?\b/g, (match) => match.endsWith('s') ? 'Taxable results' : 'Taxable result')
      .replace(/\bfiscal results?\b/g, (match) => match.endsWith('s') ? 'taxable results' : 'taxable result')
      .replace(/\bFiscal losses\b/g, 'Tax losses')
      .replace(/\bfiscal losses\b/g, 'tax losses')
      .replace(/\bFiscal loss\b/g, 'Tax loss')
      .replace(/\bfiscal loss\b/g, 'tax loss')
      .replace(/\bFiscal Code\b/g, 'Tax Code')
      .replace(/\bFiscal code\b/g, 'Tax Code')
      .replace(/\bfiscal record register\b/g, 'tax records register');
  }
  if (Array.isArray(value)) return value.map(standardiseTaxTerms);
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) value[key] = standardiseTaxTerms(value[key]);
  }
  return value;
}

for (const name of fs.readdirSync(ROOT).filter((file) => /^cuprins-carte(?:-cap(?:\d+|[A-F]))?\.json$/.test(file))) {
  const file = path.join(ROOT, name);
  const json = standardiseTaxTerms(JSON.parse(fs.readFileSync(file, 'utf8')));
  fs.writeFileSync(file, `${JSON.stringify(json, null, 1)}\n`);
}

const manifestFile = path.join(ROOT, 'translation-manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
manifest.editorialReview = {
  version: 'expert-accounting-review-2026-08-27',
  language: 'en-GB',
  scope: 'professional terminology, 2026 updates, numeric and structural parity'
};
for (const name of Object.keys(manifest.files || {})) {
  const file = path.join(ROOT, name);
  if (fs.existsSync(file)) {
    manifest.files[name].targetSha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }
}
fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

console.log('Revizia editorială EN a fost aplicată.');
