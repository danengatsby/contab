'use strict';

// Generator SAF-T (D406) — fisierul standard de audit fiscal cerut de ANAF.
// Produce un XML bine-format, aliniat la structura OECD SAF-T 2.0 adaptata RO,
// cu Header + MasterFiles (conturi, clienti, furnizori, cote TVA) + GeneralLedgerEntries.
// Nota: validarea oficiala ANAF necesita schema XSD D406 si, dupa caz, sectiunile
// SourceDocuments / Assets / Stocks (conditionate). Acopera nucleul contabil (GL).

const { round2 } = require('./util');
const { umCode } = require('./xml');
const { postedEntries } = require('./accounting'); // ciornele nu intra in SAF-T (doar articole postate)

// id de partener in format oficial 00+CUI; fara partener, firma insasi (validatorul cere campul)
function pid00(e, db) {
  const cui = String(e.partenerCui || (db && db.company && db.company.cui) || '').replace(/^ro/i, '').replace(/\s/g, '');
  return esc('00' + cui);
}
const coa = require('./chartOfAccounts');
const fiscal = require('./fiscal');
const assetsLib = require('./assets');

// Generarea la volume mari (zeci de mii de articole) e CPU-bound si ar bloca event loop-ul cateva
// sute de ms — adica ar ingheta TOATE celelalte cereri cat timp ruleaza. Variantele *Async cedeaza
// event loop-ul la fiecare SAFT_YIELD_EVERY iteratii (fara infra, fara worker), pastrand output-ul
// byte-identic cu cel sincron. La volume mici (productia normala) yield-ul e neglijabil.
// La cate randuri cedeaza generarea asincrona controlul buclei de evenimente. Implicit 2000:
// destul de rar cat sa nu coste, destul de des cat serverul sa ramana receptiv pe un SAF-T mare.
// CONTAB_SAFT_YIELD_EVERY il coboara in teste, ca sa se declanseze cedari reale pe date mici.
const SAFT_YIELD_EVERY = Number(process.env.CONTAB_SAFT_YIELD_EVERY || 2000);
const microYield = () => new Promise((resolve) => setImmediate(resolve));
const stocksLib = require('./stocks');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
const num2 = (x) => (Number(x) || 0).toFixed(2);
const roCui = (cui) => 'RO' + String(cui || '').replace(/^ro/i, '').replace(/\s/g, '');

// `p` poate fi un an ('YYYY') sau o luna ('YYYY-MM') — D406 se depune lunar/trimestrial din 2025.
function inYear(e, p) {
  const s = String(e.period || e.data || ''); const q = String(p);
  const tr = q.match(/^(\d{4})-Q([1-4])$/);
  if (tr) { const n = Number(tr[2]); const luni = [n * 3 - 2, n * 3 - 1, n * 3].map((x) => tr[1] + '-' + String(x).padStart(2, '0')); return luni.includes(s.slice(0, 7)); }
  return q.length === 7 ? s.slice(0, 7) === q : s.slice(0, 4) === q;
}
function beforeYear(e, p) {
  const s = String(e.period || e.data || ''); const q = String(p);
  const tr = q.match(/^(\d{4})-Q([1-4])$/);
  if (tr) return s.slice(0, 7) < (tr[1] + '-' + String(Number(tr[2]) * 3 - 2).padStart(2, '0'));
  return q.length === 7 ? s.slice(0, 7) < q : s.slice(0, 4) < q;
}

/** Net {d,c} acumulat pe cont dintr-o lista de inregistrari. */
function accumulate(entries) {
  const m = {};
  for (const e of entries) {
    for (const l of e.lines) {
      (m[l.debit] = m[l.debit] || { d: 0, c: 0 }).d = round2(m[l.debit].d + l.suma);
      (m[l.credit] = m[l.credit] || { d: 0, c: 0 }).c = round2(m[l.credit].c + l.suma);
    }
  }
  return m;
}

/** Tipul de cont SAF-T pe baza naturii din planul de conturi. */
function accountType(cod) {
  const a = coa.getAccount(cod);
  if (!a) return 'Bifunctional';
  if (a.tip === 'A' || a.tip === 'C') return 'Activ';
  if (a.tip === 'P' || a.tip === 'V') return 'Pasiv';
  return 'Bifunctional';
}

/** Soldurile de deschidere/inchidere ale anului, pe cont. */
function accountBalances(db, year) {
  const opening = db.openingBalances || {};
  const before = accumulate(postedEntries(db).filter((e) => beforeYear(e, year)));
  const within = accumulate(postedEntries(db).filter((e) => inYear(e, year)));
  const codes = new Set([...Object.keys(opening), ...Object.keys(before), ...Object.keys(within)]);
  const rows = [];
  for (const cod of [...codes].sort()) {
    const op = opening[cod] || { d: 0, c: 0 };
    const bf = before[cod] || { d: 0, c: 0 };
    const wi = within[cod] || { d: 0, c: 0 };
    const openNet = round2((op.d + bf.d) - (op.c + bf.c));
    const closeNet = round2(openNet + wi.d - wi.c);
    if (openNet === 0 && wi.d === 0 && wi.c === 0 && closeNet === 0) continue;
    rows.push({ cod, openNet, closeNet });
  }
  return rows;
}

/** Imparte partenerii in clienti/furnizori dupa conturile folosite in inregistrari. */
function partnerRoles(db, year) {
  const customers = new Map(); // key (nume) -> {den, cui, bal}
  const suppliers = new Map();
  const ofClient = ['4111', '411', '4118', '461'];
  const ofFurnizor = ['401', '404', '408'];
  const touch = (map, e) => {
    const key = (e.partener || e.partenerCui || '').toUpperCase().trim();
    if (!key) return null;
    if (!map.has(key)) map.set(key, { den: e.partener || key, cui: e.partenerCui || '', bal: 0 });
    return map.get(key);
  };
  for (const e of postedEntries(db)) {
    if (!inYear(e, year)) continue;
    for (const l of e.lines) {
      if (ofClient.includes(l.debit) || ofClient.includes(l.credit)) {
        const r = touch(customers, e); if (r) r.bal = round2(r.bal + (ofClient.includes(l.debit) ? l.suma : -l.suma));
      }
      if (ofFurnizor.includes(l.debit) || ofFurnizor.includes(l.credit)) {
        const r = touch(suppliers, e); if (r) r.bal = round2(r.bal + (ofFurnizor.includes(l.credit) ? l.suma : -l.suma));
      }
    }
  }
  return { customers: [...customers.values()], suppliers: [...suppliers.values()] };
}

function partnerInfo(db, cui) {
  const p = (db.partners || {})[String(cui || '').replace(/^ro/i, '').replace(/\s/g, '')];
  return p || {};
}

function addressXml(p, pad) {
  return [
    `${pad}<StreetName>${esc(p.adresa || 'N/A')}</StreetName>`,
    `${pad}<City>${esc(p.oras || 'N/A')}</City>`,
    `${pad}<Region>${esc(/^RO-/.test(String(p.judet)) ? p.judet : 'RO-B')}</Region>`,
    `${pad}<Country>${esc(p.tara || 'RO')}</Country>`,
  ].join('\n');
}

// D406 acopera o LUNA sau un TRIMESTRU ('YYYY-Qn', pentru platitorii TVA trimestriali) — ambele
// sunt varianta periodica (L); anul intreg ('YYYY') e varianta anuala (A).
function saftIsPeriodic(year) { return /^\d{4}-(\d{2}|Q[1-4])$/.test(String(year)); }
// Codul tipului de declaratie (HeaderComment): L = lunar, T = trimestrial, A = anual.
// Validatorul verifica potrivirea cu intervalul PeriodStart..PeriodEnd.
function saftHeaderCode(year) {
  if (/^\d{4}-Q[1-4]$/.test(String(year))) return 'T';
  if (/^\d{4}-\d{2}$/.test(String(year))) return 'L';
  return 'A';
}
function saftPeriodRange(year) {
  const q = String(year).match(/^\d{4}-Q([1-4])$/);
  if (q) { const n = Number(q[1]); return { start: n * 3 - 2, end: n * 3 }; }
  const m = String(year).match(/^\d{4}-(\d{2})$/);
  if (m) return { start: Number(m[1]), end: Number(m[1]) };
  return { start: 1, end: 12 };
}

function header(company, year) {
  const now = new Date().toISOString().slice(0, 10);
  return [
    '  <Header>',
    '    <AuditFileVersion>2.4.9</AuditFileVersion>',
    '    <AuditFileCountry>RO</AuditFileCountry>',
    `    <AuditFileRegion>${esc(/^RO-/.test(String(company.judet)) ? company.judet : 'RO-B')}</AuditFileRegion>`,
    `    <AuditFileDateCreated>${now}</AuditFileDateCreated>`,
    '    <SoftwareCompanyName>Contabo</SoftwareCompanyName>',
    '    <SoftwareID>Contabo</SoftwareID>',
    '    <SoftwareVersion>1.0</SoftwareVersion>',
    '    <Company>',
    `      <RegistrationNumber>${esc(company.tvaPlatitor ? roCui(company.cui) : company.cui)}</RegistrationNumber>`,
    `      <Name>${esc(company.nume)}</Name>`,
    '      <Address>',
    addressXml(company, '        '),
    '        <AddressType>StreetAddress</AddressType>',
    '      </Address>',
    '      <Contact>',
    '        <ContactPerson>',
    '          <FirstName>N/A</FirstName>',
    `          <LastName>${esc(company.nume)}</LastName>`,
    '        </ContactPerson>',
    `        <Telephone>${esc(company.telefon || '-')}</Telephone>`,
    '      </Contact>',
    '      <TaxRegistration>',
    `        <TaxRegistrationNumber>${esc(company.tvaPlatitor ? roCui(company.cui) : company.cui)}</TaxRegistrationNumber>`,
    '      </TaxRegistration>',
    '      <BankAccount>',
    `        <IBANNumber>${esc(String(company.iban || 'RO00XXXX0000000000000000').replace(/\s/g, ''))}</IBANNumber>`,
    '      </BankAccount>',
    '    </Company>',
    '    <DefaultCurrencyCode>RON</DefaultCurrencyCode>',
    '    <SelectionCriteria>',
    `      <PeriodStart>${saftPeriodRange(year).start}</PeriodStart>`,
    `      <PeriodStartYear>${String(year).slice(0, 4)}</PeriodStartYear>`,
    `      <PeriodEnd>${saftPeriodRange(year).end}</PeriodEnd>`,
    `      <PeriodEndYear>${String(year).slice(0, 4)}</PeriodEndYear>`,
    '    </SelectionCriteria>',
    `    <HeaderComment>${company._saftTip || saftHeaderCode(year)}</HeaderComment>`,
    '    <SegmentIndex>1</SegmentIndex>',
    '    <TotalSegmentsInsequence>1</TotalSegmentsInsequence>',
    '    <TaxAccountingBasis>A</TaxAccountingBasis>',
    '    <TaxEntity>Company</TaxEntity>',
    '  </Header>',
  ].join('\n');
}

function generalLedgerAccounts(db, year) {
  const out = ['    <GeneralLedgerAccounts>'];
  for (const b of accountBalances(db, year)) {
    const at = accountType(b.cod);
    const opD = b.openNet >= 0 ? num2(b.openNet) : '0.00';
    const opC = b.openNet < 0 ? num2(-b.openNet) : '0.00';
    const clD = b.closeNet >= 0 ? num2(b.closeNet) : '0.00';
    const clC = b.closeNet < 0 ? num2(-b.closeNet) : '0.00';
    out.push(
      '      <Account>',
      `        <AccountID>${esc(b.cod)}</AccountID>`,
      `        <AccountDescription>${esc(coa.accountName(b.cod))}</AccountDescription>`,
      `        <StandardAccountID>${esc(b.cod)}</StandardAccountID>`,
      `        <AccountType>${at}</AccountType>`,
      Number(opC) > 0 && Number(opD) === 0 ? `        <OpeningCreditBalance>${opC}</OpeningCreditBalance>` : `        <OpeningDebitBalance>${opD}</OpeningDebitBalance>`,
      Number(clC) > 0 && Number(clD) === 0 ? `        <ClosingCreditBalance>${clC}</ClosingCreditBalance>` : `        <ClosingDebitBalance>${clD}</ClosingDebitBalance>`,
      '      </Account>',
    );
  }
  out.push('    </GeneralLedgerAccounts>');
  return out.join('\n');
}

function partyXml(tag, idTag, accountId, list, db) {
  const out = [`    <${tag}s>`];
  list.forEach((p, _i) => {
    const info = partnerInfo(db, p.cui);
    // RegistrationNumber in SAF-T: "00" + CUI numeric pentru RO; "01" + cod tara + cod TVA
    // pentru UE (ghidul oficial D406 — prefixul fiscal "RO" NU se scrie)
    const cuiCurat = String(p.cui || '').replace(/\s/g, '');
    const reg = !cuiCurat ? '00' : /^ro/i.test(cuiCurat) || /^\d+$/.test(cuiCurat)
      ? '00' + cuiCurat.replace(/^ro/i, '')
      : '01' + cuiCurat;
    const balD = p.bal >= 0 ? num2(p.bal) : '0.00';
    // ordinea ceruta de parserul DUK: ID + cont + solduri intai, identitatea (CompanyStructure)
    // la final; ID-ul partenerului este chiar codul 00/01+CUI (ghidul oficial D406)
    out.push(
      `      <${tag}>`,
      // structura ceruta de validatorul D406: CompanyStructure = DOAR nr. inregistrare + nume
      '        <CompanyStructure>',
      `          <RegistrationNumber>${esc(reg)}</RegistrationNumber>`,
      `          <Name>${esc(p.den)}</Name>`,
      '          <Address>',
      addressXml(info, '            '),
      '            <AddressType>StreetAddress</AddressType>',
      '          </Address>',
      '        </CompanyStructure>',
      `        <${idTag}>${esc(reg)}</${idTag}>`,
      `        <AccountID>${accountId}</AccountID>`,
      `        <OpeningDebitBalance>0.00</OpeningDebitBalance>`,
      tag === 'Customer'
        ? `        <ClosingDebitBalance>${balD}</ClosingDebitBalance>`
        : `        <ClosingCreditBalance>${p.bal <= 0 ? num2(-p.bal) : '0.00'}</ClosingCreditBalance>`,
      `      </${tag}>`,
    );
  });
  out.push(`    </${tag}s>`);
  return out.join('\n');
}

function taxTable(year) {
  const raw = String(year || ''); const q = raw.match(/^(\d{4})-Q([1-4])$/);
  const when = /^\d{4}$/.test(raw) ? raw + '-12'
    : q ? q[1] + '-' + String(Number(q[2]) * 3).padStart(2, '0') : raw;
  const f = fiscal.rulesAt(when).rates;
  const std = f.tvaStandard || 21;
  const red = f.tvaRedus || 11;
  const rates = [
    { code: '300101', pct: std, desc: 'TVA cota standard' },
    { code: '300102', pct: red, desc: 'TVA cota redusa' },
    { code: '300103', pct: 0, desc: 'TVA scutit' },
  ];
  const out = ['    <TaxTable>', '      <TaxTableEntry>',
    '        <TaxType>300</TaxType>',
    '        <Description>TVA</Description>'];
  for (const r of rates) {
    out.push(
      '        <TaxCodeDetails>',
      `          <TaxCode>${r.code}</TaxCode>`,
      `          <Description>${esc(r.desc)}</Description>`,
      `          <TaxPercentage>${num2(r.pct)}</TaxPercentage>`,
      '          <BaseRate>1</BaseRate>',
      '          <Country>RO</Country>',
      '        </TaxCodeDetails>',
    );
  }
  out.push('      </TaxTableEntry>', '    </TaxTable>');
  return out.join('\n');
}

function assetsXml(db, year) {
  const list = db.assets || [];
  const out = ['    <Assets>'];
  list.forEach((a, _i) => {
    const cEnd = assetsLib.compute(a, year + '-12');
    const cBegin = assetsLib.compute(a, (Number(year) - 1) + '-12');
    const depYear = round2(cEnd.amortizareCumulata - cBegin.amortizareCumulata);
    out.push(
      '      <Asset>',
      `        <AssetID>${esc(a.id)}</AssetID>`,
      `        <AccountID>${esc(a.cont)}</AccountID>`,
      `        <Description>${esc(a.denumire)}</Description>`,
      `        <DateOfAcquisition>${esc(a.dataAchizitie || a.dataPif)}</DateOfAcquisition>`,
      `        <StartUpDate>${esc(a.dataPif)}</StartUpDate>`,
      '        <Valuations>',
      '          <Valuation>',
      '            <AssetValuationType>CST</AssetValuationType>',
      '            <ValuationClass>CST</ValuationClass>',
      `            <AcquisitionAndProductionCostsBegin>${num2(a.cost)}</AcquisitionAndProductionCostsBegin>`,
      `            <AcquisitionAndProductionCostsEnd>${num2(a.cost)}</AcquisitionAndProductionCostsEnd>`,
      '            <InvestmentSupport>0.00</InvestmentSupport>',
      `            <AssetLifeMonth>${a.durataLuni || 0}</AssetLifeMonth>`,
      '            <AssetAddition>0.00</AssetAddition>',
      '            <Transfers>0.00</Transfers>',
      '            <AssetDisposal>0.00</AssetDisposal>',
      `            <BookValueBegin>${num2(a.cost)}</BookValueBegin>`,
      `            <DepreciationMethod>${a.metoda === 'degresiva' ? 'D' : a.metoda === 'accelerata' ? 'A' : 'L'}</DepreciationMethod>`,
      '            <DepreciationPercentage>0.00</DepreciationPercentage>',
      `            <DepreciationForPeriod>${num2(depYear)}</DepreciationForPeriod>`,
      '            <AppreciationForPeriod>0.00</AppreciationForPeriod>',
      '            <ExtraordinaryDepreciationsForPeriod><ExtraordinaryDepreciationForPeriod><ExtraordinaryDepreciationMethod>-</ExtraordinaryDepreciationMethod><ExtraordinaryDepreciationAmountForPeriod>0.00</ExtraordinaryDepreciationAmountForPeriod></ExtraordinaryDepreciationForPeriod></ExtraordinaryDepreciationsForPeriod>',
      `            <AccumulatedDepreciation>${num2(cEnd.amortizareCumulata)}</AccumulatedDepreciation>`,
      `            <BookValueEnd>${num2(cEnd.valoareRamasa)}</BookValueEnd>`,
      '          </Valuation>',
      '        </Valuations>',
      '      </Asset>',
    );
  });
  out.push('    </Assets>');
  return out.join('\n');
}

function productsXml(db) {
  const out = ['    <Products>'];
  for (const p of (db.products || [])) {
    out.push(
      '      <Product>',
      `        <ProductCode>${esc(p.cod)}</ProductCode>`,
      `        <ProductGroup>${esc(p.grupa || 'Marfuri')}</ProductGroup>`,
      `        <Description>${esc(p.denumire)}</Description>`,
      `        <ProductCommodityCode>${esc(p.codNC || '0')}</ProductCommodityCode>`,
      '        <ValuationMethod>CMP</ValuationMethod>',
      `        <UOMBase>${umCode(p.um)}</UOMBase>`,
      `        <UOMStandard>${umCode(p.um)}</UOMStandard>`,
      '        <UOMToUOMBaseConversionFactor>1</UOMToUOMBaseConversionFactor>',
      '      </Product>',
    );
  }
  out.push('    </Products>');
  return out.join('\n');
}

function physicalStockXml(db, year) {
  if (db._saftTip !== 'C') return ''; // PhysicalStock apartine DOAR declaratiei de stocuri (C)
  const stock = stocksLib.currentStock(db, year + '-12');
  const out = ['    <PhysicalStock>'];
  for (const s of stock) {
    out.push(
      '      <PhysicalStockEntry>',
      `        <WarehouseID>${esc((s.gestiune && s.gestiune.cod) || 'GEST')}</WarehouseID>`,
      `        <ProductCode>${esc(s.product.cod)}</ProductCode>`,
      `        <StockAccountNo>${esc(s.product.cont || '371')}</StockAccountNo>`,
      '        <ProductType>P</ProductType>',
      '        <ProductStatus>IN_STOCK</ProductStatus>',
      '        <StockAccountCommodityCode>0</StockAccountCommodityCode>',
      `        <OwnerID>${esc('00' + String((db.company && db.company.cui) || '').replace(/^ro/i, '').replace(/\s/g, ''))}</OwnerID>`,
      `        <UOMPhysicalStock>${umCode(s.product.um)}</UOMPhysicalStock>`,
      '        <UOMToUOMBaseConversionFactor>1</UOMToUOMBaseConversionFactor>',
      `        <UnitPrice>${num2(s.cmp)}</UnitPrice>`,
      '        <OpeningStockQuantity>0.00</OpeningStockQuantity>',
      '        <OpeningStockValue>0.00</OpeningStockValue>',
      `        <ClosingStockQuantity>${num2(s.stocQ)}</ClosingStockQuantity>`,
      `        <ClosingStockValue>${num2(s.stocV)}</ClosingStockValue>`,
      '        <StockCharacteristics><StockCharacteristic>-</StockCharacteristic><StockCharacteristicValue>-</StockCharacteristicValue></StockCharacteristics>',
      '      </PhysicalStockEntry>',
    );
  }
  out.push('    </PhysicalStock>');
  return out.join('\n');
}

/** UOMTable — unitatile de masura folosite in nomenclatorul de produse (cerut de XSD D406). */
function uomTable(db) {
  const ums = [...new Set((db.products || []).map((p) => umCode(p.um)))].sort();
  if (!ums.length) ums.push('C62');
  const out = ['    <UOMTable>'];
  for (const u of ums) {
    out.push('      <UOMTableEntry>',
      `        <UnitOfMeasure>${esc(u)}</UnitOfMeasure>`,
      `        <Description>${esc(u)}</Description>`,
      '      </UOMTableEntry>');
  }
  out.push('    </UOMTable>');
  return out.join('\n');
}

/** MovementTypeTable — tipurile de miscari de stoc emise in MovementOfGoods (cerut de XSD D406). */
function movementTypeTable() {
  // nomenclatorul de tipuri e dezactivat in versiunea curenta a validatorului: sectiunea
  // ramane obligatorie, dar GOALA (intrarile au maxOccurs=0)
  return '    <MovementTypeTable/>';
}

/** Owners — asociatii/actionarii firmei (Setari -> Datele firmei, un rand pe asociat:
 *  "Nume; CNP/CUI; procent"). Pentru PFA fara lista: titularul cu 100%.
 *
 *  NELEGATA: functia e completa, dar nimeni nu o cheama — sectiunea <Owners> NU ajunge azi in
 *  D406. Campul `asociatiText` din profilul firmei exista si se poate completa din Setari, deci
 *  ce scrie utilizatorul acolo nu ajunge nicaieri. Se pastreaza (nu e cod mort, e o functie
 *  neconectata), dar legarea ei e o schimbare FISCALA: cere trecerea prin DUKIntegrator. */
// eslint-disable-next-line no-unused-vars -- construita, nelegata inca (vezi comentariul de mai sus)
function ownersXml(db) {
  const c = db.company || {};
  const rows = String(c.asociatiText || '').trim()
    ? String(c.asociatiText).trim().split(/\r?\n/).map((l) => l.split(';').map((s) => s.trim())).filter((a) => a[0])
    : (c.tipEntitate === 'pfa' ? [[c.nume || 'Titular', String(c.cui || ''), '100']] : []);
  if (!rows.length) rows.push([c.nume || 'Titular', String(c.cui || ''), '100']);
  const out = ['    <Owners>'];
  rows.forEach((a, i) => out.push('      <Owner>',
    `        <OwnerID>${i + 1}</OwnerID>`,
    `        <AccountID>456</AccountID>`,
    '      </Owner>'));
  out.push('    </Owners>');
  return out.join('\n');
}

function masterFiles(db, year) {
  const lunar = saftIsPeriodic(year);
  const roles = partnerRoles(db, year);
  // varianta ANUALA (A = declaratia de Active): dictionarul validatorului dezactiveaza
  // continutul sectiunilor de parteneri/taxe/produse — raman GOALE; pline sunt doar
  // planul de conturi si Assets. In lunar (L) e invers: totul plin, Assets/Owners goale.
  return [
    '  <MasterFiles>',
    generalLedgerAccounts(db, year),
    lunar ? partyXml('Customer', 'CustomerID', '4111', roles.customers, db) : '    <Customers/>',
    lunar ? partyXml('Supplier', 'SupplierID', '401', roles.suppliers, db) : '    <Suppliers/>',
    lunar ? taxTable(year) : '    <TaxTable/>',
    lunar ? uomTable(db) : '    <UOMTable/>',
    '    <AnalysisTypeTable/>',
    movementTypeTable(),
    lunar ? productsXml(db) : '    <Products/>',
    physicalStockXml(db, year),
    '    <Owners/>',
    lunar || db._saftTip === 'C' ? '    <Assets/>' : assetsXml(db, year),
    '  </MasterFiles>',
  ].filter(Boolean).join('\n');
}

function movementOfGoodsXml(db, year) {
  if (saftIsPeriodic(year)) return '    <MovementOfGoods/>'; // gol in varianta periodica (vezi mai sus)
  const byId = new Map((db.products || []).map((p) => [p.id, p]));
  const movs = stocksLib.sortMov((db.stockMovements || []).filter((m) => inYear({ data: m.data }, year)));
  let qIn = 0; let qOut = 0; const lines = [];
  movs.forEach((m, i) => {
    const p = byId.get(m.productId) || {};
    const c = round2(Number(m.cantitate) || 0);
    const type = m.tip === 'receptie' ? '10' : m.tip === 'transfer' ? '40' : '20';
    if (m.tip === 'receptie') qIn = round2(qIn + c);
    else if (m.tip === 'iesire') qOut = round2(qOut + c); // transferurile = interne, nu in totaluri
    lines.push(
      '        <StockMovement>',
      `          <MovementReference>${esc(m.document || m.id)}</MovementReference>`,
      `          <MovementDate>${esc(m.data)}</MovementDate>`,
      `          <MovementType>${type}</MovementType>`,
      '          <StockMovementLine>',
      `            <LineNumber>${i + 1}</LineNumber>`,
      '            <AccountID>371</AccountID>',
      `            <CustomerID>${pid00({}, db)}</CustomerID>`,
      `            <SupplierID>${pid00({}, db)}</SupplierID>`,
      `            <ProductCode>${esc(p.cod || m.productId)}</ProductCode>`,
      `            <Quantity>${num2(c)}</Quantity>`,
      `            <UnitOfMeasure>${umCode(p.um)}</UnitOfMeasure>`,
      '            <UOMToUOMPhysicalStockConversionFactor>1</UOMToUOMPhysicalStockConversionFactor>',
      `            <BookValue>${num2((m.cantitate || 0) * (m.pretUnitar || 0))}</BookValue>`,
      `            <MovementSubType>${type}</MovementSubType>`,
      '          </StockMovementLine>',
      '        </StockMovement>',
    );
  });
  return [
    '    <MovementOfGoods>',
    `      <NumberOfMovementLines>${movs.length}</NumberOfMovementLines>`,
    `      <TotalQuantityReceived>${num2(qIn)}</TotalQuantityReceived>`,
    `      <TotalQuantityIssued>${num2(qOut)}</TotalQuantityIssued>`,
    lines.join('\n'),
    '    </MovementOfGoods>',
  ].join('\n');
}

// Construieste blocul <Transaction> pentru un articol (folosit identic de calea sincrona si cea
// asincrona — extras ca sa nu existe doua implementari care pot diverge).
function glTx(e, year, db) {
  const month = Number(String(e.period || e.data).slice(5, 7)) || 1;
  const sysDate = String(e.data);
  let rec = 0;
  const lines = [];
  for (const l of e.lines) {
    rec += 1;
    lines.push(
      '          <TransactionLine>',
      `            <RecordID>${esc(e.id)}-${rec}D</RecordID>`,
      `            <AccountID>${esc(l.debit)}</AccountID>`,
      `            <CustomerID>${pid00(e, db)}</CustomerID>`,
      `            <SupplierID>${pid00(e, db)}</SupplierID>`,
      `            <Description>${esc(l.explicatie || e.explicatie || e.tipNume)}</Description>`,
      `            <DebitAmount><Amount>${num2(l.suma)}</Amount><CurrencyCode>RON</CurrencyCode><CurrencyAmount>0.00</CurrencyAmount></DebitAmount>`,
      '            <TaxInformation><TaxType>300</TaxType><TaxCode>300101</TaxCode><TaxAmount><Amount>0.00</Amount><CurrencyCode>RON</CurrencyCode><CurrencyAmount>0.00</CurrencyAmount></TaxAmount></TaxInformation>',
      '          </TransactionLine>',
    );
    rec += 1;
    lines.push(
      '          <TransactionLine>',
      `            <RecordID>${esc(e.id)}-${rec}C</RecordID>`,
      `            <AccountID>${esc(l.credit)}</AccountID>`,
      `            <CustomerID>${pid00(e, db)}</CustomerID>`,
      `            <SupplierID>${pid00(e, db)}</SupplierID>`,
      `            <Description>${esc(l.explicatie || e.explicatie || e.tipNume)}</Description>`,
      `            <CreditAmount><Amount>${num2(l.suma)}</Amount><CurrencyCode>RON</CurrencyCode><CurrencyAmount>0.00</CurrencyAmount></CreditAmount>`,
      '            <TaxInformation><TaxType>300</TaxType><TaxCode>300101</TaxCode><TaxAmount><Amount>0.00</Amount><CurrencyCode>RON</CurrencyCode><CurrencyAmount>0.00</CurrencyAmount></TaxAmount></TaxInformation>',
      '          </TransactionLine>',
    );
  }
  return [
    '        <Transaction>',
    `          <TransactionID>${esc(e.id)}</TransactionID>`,
    `          <Period>${month}</Period>`,
    `          <PeriodYear>${String(year).slice(0, 4)}</PeriodYear>`,
    `          <TransactionDate>${sysDate}</TransactionDate>`,
    `          <Description>${esc(e.tipNume + (e.document ? ' ' + e.document : ''))}</Description>`,
    `          <SystemEntryDate>${sysDate}</SystemEntryDate>`,
    `          <GLPostingDate>${sysDate}</GLPostingDate>`,
    `          <CustomerID>${pid00(e, db)}</CustomerID>`,
    `          <SupplierID>${pid00(e, db)}</SupplierID>`,
    lines.join('\n'),
    '        </Transaction>',
  ];
}
function glEntriesSorted(db, year) {
  return postedEntries(db).filter((e) => inYear(e, year))
    .sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : String(a.id).localeCompare(String(b.id))));
}
function glWrap(entries, year, txs) {
  if (!saftIsPeriodic(year)) return '  <GeneralLedgerEntries/>'; // gol in varianta A
  let totalD = 0; let totalC = 0;
  for (const e of entries) for (const l of e.lines) { totalD = round2(totalD + l.suma); totalC = round2(totalC + l.suma); }
  return [
    '  <GeneralLedgerEntries>',
    `    <NumberOfEntries>${entries.length}</NumberOfEntries>`,
    `    <TotalDebit>${num2(totalD)}</TotalDebit>`,
    `    <TotalCredit>${num2(totalC)}</TotalCredit>`,
    '    <Journal>',
    '      <JournalID>GL</JournalID>',
    '      <Description>Registru jurnal</Description>',
    '      <Type>GL</Type>',
    txs.join('\n'),
    '    </Journal>',
    '  </GeneralLedgerEntries>',
  ].join('\n');
}
function generalLedgerEntries(db, year) {
  const entries = glEntriesSorted(db, year);
  const txs = [];
  for (const e of entries) txs.push(glTx(e, year, db).join('\n'));
  return glWrap(entries, year, txs);
}
// Varianta asincrona: cedeaza event loop-ul periodic (bucla dominanta la volume mari). Output
// byte-identic cu cel sincron (acelasi glTx/glWrap) — verificat in teste.
async function generalLedgerEntriesAsync(db, year) {
  const entries = glEntriesSorted(db, year);
  const txs = [];
  let i = 0;
  for (const e of entries) {
    txs.push(glTx(e, year, db).join('\n'));
    if ((i += 1) % SAFT_YIELD_EVERY === 0) await microYield();
  }
  return glWrap(entries, year, txs);
}

// ───────────────────────── SourceDocuments (facturi) ─────────────────────────
const SALE_TIP = (t) => /^factura_vanzare/.test(t) || t === 'livrare_intracomunitara' || t === 'factura_storno_vanzare';
const PURCHASE_TIP = (t) => /^factura_cumparare/.test(t) || t === 'factura_storno_cumparare';
const isRevenue = (c) => /^70/.test(c);
const isExpenseOrStock = (c) => /^[36]/.test(c) && c !== '4426';

/** Extrage net/TVA/total + liniile unei facturi (din e.items daca exista, altfel din articolul contabil). */
function invoiceExtract(e, kind) {
  let net = 0; let tax = 0; const lines = [];
  // contul reprezentativ de venit/cheltuiala din articol
  const repAcc = (() => {
    for (const l of e.lines) {
      if (kind === 'sale' && isRevenue(l.credit)) return l.credit;
      if (kind === 'purchase' && isExpenseOrStock(l.debit)) return l.debit;
    }
    return kind === 'sale' ? '707' : '371';
  })();

  if (e.items && e.items.length) {
    e.items.forEach((it, i) => {
      const base = round2((Number(it.cantitate) || 0) * (Number(it.pret) || 0));
      const cota = Number(it.cota) || 0;
      const t = round2((base * cota) / 100);
      net = round2(net + base); tax = round2(tax + t);
      lines.push({ n: i + 1, acc: repAcc, desc: it.nume || repAcc, qty: Number(it.cantitate) || 1, um: it.um || 'buc', price: Number(it.pret) || base, amount: base, cota, tax: t });
    });
  } else {
    // derivare din articolul contabil
    for (const l of e.lines) {
      if (kind === 'sale' && l.credit === '4427') tax = round2(tax + l.suma);
      if (kind === 'purchase' && l.debit === '4426') tax = round2(tax + l.suma);
    }
    const baseLines = e.lines.filter((l) => (kind === 'sale' ? isRevenue(l.credit) : isExpenseOrStock(l.debit)));
    const baseTotal = round2(baseLines.reduce((s, l) => s + l.suma, 0));
    const cota = baseTotal > 0 && tax > 0 ? Math.round((tax / baseTotal) * 100) : 0;
    baseLines.forEach((l, i) => {
      const acc = kind === 'sale' ? l.credit : l.debit;
      const t = round2((l.suma * cota) / 100);
      net = round2(net + l.suma);
      lines.push({ n: i + 1, acc, desc: l.explicatie || coa.accountName(acc), qty: 1, um: 'buc', price: l.suma, amount: l.suma, cota, tax: t });
    });
  }
  return { net, tax, total: round2(net + tax), lines };
}

function invoiceXml(e, kind, partyTag, partyIdTag, partyId, defaultAccount) {
  const data = invoiceExtract(e, kind);
  const month = Number(String(e.period || e.data).slice(5, 7)) || 1;
  const date = String(e.data);
  const amtTag = kind === 'sale' ? 'CreditAmount' : 'DebitAmount';
  const invType = /storno/.test(e.tip) ? '381' : '380';
  const out = [
    '      <Invoice>',
    `        <InvoiceNo>${esc(e.document || e.id)}</InvoiceNo>`,
    `        <${partyTag}>`,
    `          <${partyIdTag}>${esc(partyId)}</${partyIdTag}>`,
    '          <BillingAddress>',
    addressXml({}, '            '),
    '            <AddressType>StreetAddress</AddressType>',
    '          </BillingAddress>',
    `        </${partyTag}>`,
    `        <AccountID>${defaultAccount}</AccountID>`,
    `        <Period>${month}</Period>`,
    `        <InvoiceDate>${date}</InvoiceDate>`,
    `        <InvoiceType>${invType}</InvoiceType>`,
    '        <SelfBillingIndicator>0</SelfBillingIndicator>',
    `        <GLPostingDate>${date}</GLPostingDate>`,
    `        <TransactionID>${esc(e.id)}</TransactionID>`,
  ];
  for (const l of data.lines) {
    out.push(
      '        <InvoiceLine>',
      `          <LineNumber>${l.n}</LineNumber>`,
      `          <AccountID>${esc(l.acc)}</AccountID>`,
      `          <ProductDescription>${esc(l.desc)}</ProductDescription>`,
      `          <Quantity>${num2(l.qty)}</Quantity>`,
      `          <InvoiceUOM>${umCode(l.um)}</InvoiceUOM>`,
      `          <UnitPrice>${num2(l.price)}</UnitPrice>`,
      `          <TaxPointDate>${date}</TaxPointDate>`,
      `          <Description>${esc(l.desc)}</Description>`,
      `          <InvoiceLineAmount><Amount>${num2(l.amount)}</Amount><CurrencyCode>RON</CurrencyCode><CurrencyAmount>0.00</CurrencyAmount></InvoiceLineAmount>`,
      `          <DebitCreditIndicator>${amtTag === 'DebitAmount' ? 'D' : 'C'}</DebitCreditIndicator>`,
      '          <TaxInformation>',
      '            <TaxType>300</TaxType>',
      `            <TaxCode>${l.cota >= 19 ? '300101' : l.cota > 0 ? '300102' : '300103'}</TaxCode>`,
      `            <TaxPercentage>${num2(l.cota)}</TaxPercentage>`,
      `            <TaxAmount><Amount>${num2(l.tax)}</Amount><CurrencyCode>RON</CurrencyCode><CurrencyAmount>0.00</CurrencyAmount></TaxAmount>`,
      '          </TaxInformation>',
      '        </InvoiceLine>',
    );
  }
  out.push(
    '        <InvoiceDocumentTotals>',
    `          <NetTotal>${num2(data.net)}</NetTotal>`,
    `          <GrossTotal>${num2(data.total)}</GrossTotal>`,
    '        </InvoiceDocumentTotals>',
    '      </Invoice>',
  );
  return { xml: out.join('\n'), net: data.net };
}

// ───────────────────────── Payments (incasari/plati) ─────────────────────────
const PAYMENT_TIP = (t) => /^(incasare|plata)/.test(t);
const TREASURY = ['5121', '5124', '5125', '5311', '5314', '5328', '542'];
function paymentMethod(e) {
  for (const l of e.lines) {
    const acc = TREASURY.includes(l.debit) ? l.debit : TREASURY.includes(l.credit) ? l.credit : null;
    if (acc) return /^53/.test(acc) ? '01' : /^512/.test(acc) ? '03' : '02';
  }
  return 'Alte';
}
function paymentsXml(db, year) {
  const pays = postedEntries(db).filter((e) => inYear(e, year) && PAYMENT_TIP(e.tip));
  let totalD = 0; let totalC = 0; const out = [];
  for (const e of pays) {
    const date = String(e.data);
    const month = Number(String(e.period || e.data).slice(5, 7)) || 1;
    let rec = 0; const lines = [];
    for (const l of e.lines) {
      totalD = round2(totalD + l.suma); totalC = round2(totalC + l.suma);
      rec += 1;
      lines.push(
        '          <PaymentLine>',
        `            <LineNumber>${rec}</LineNumber>`,
        `            <AccountID>${esc(l.debit)}</AccountID>`,
        `            <CustomerID>${pid00(e, db)}</CustomerID>`,
        `            <SupplierID>${pid00(e, db)}</SupplierID>`,

        `            <Description>${esc(l.explicatie || e.explicatie || e.tipNume)}</Description>`,
        '            <DebitCreditIndicator>D</DebitCreditIndicator>',
        `            <PaymentLineAmount><Amount>${num2(l.suma)}</Amount><CurrencyCode>RON</CurrencyCode><CurrencyAmount>0.00</CurrencyAmount></PaymentLineAmount>`,
        '            <TaxInformation><TaxType>300</TaxType><TaxCode>300101</TaxCode><TaxAmount><Amount>0.00</Amount><CurrencyCode>RON</CurrencyCode><CurrencyAmount>0.00</CurrencyAmount></TaxAmount></TaxInformation>',
        '          </PaymentLine>',
      );
      rec += 1;
      lines.push(
        '          <PaymentLine>',
        `            <LineNumber>${rec}</LineNumber>`,
        `            <AccountID>${esc(l.credit)}</AccountID>`,
        `            <CustomerID>${pid00(e, db)}</CustomerID>`,
        `            <SupplierID>${pid00(e, db)}</SupplierID>`,

        `            <Description>${esc(l.explicatie || e.explicatie || e.tipNume)}</Description>`,
        '            <DebitCreditIndicator>C</DebitCreditIndicator>',
        `            <PaymentLineAmount><Amount>${num2(l.suma)}</Amount><CurrencyCode>RON</CurrencyCode><CurrencyAmount>0.00</CurrencyAmount></PaymentLineAmount>`,
        '            <TaxInformation><TaxType>300</TaxType><TaxCode>300101</TaxCode><TaxAmount><Amount>0.00</Amount><CurrencyCode>RON</CurrencyCode><CurrencyAmount>0.00</CurrencyAmount></TaxAmount></TaxInformation>',
        '          </PaymentLine>',
      );
    }
    const total = round2(e.lines.reduce((s, l) => s + l.suma, 0));
    out.push(
      '        <Payment>',
      `          <PaymentRefNo>${esc(e.document || e.id)}</PaymentRefNo>`,
      `          <Period>${month}</Period>`,
      `          <PeriodYear>${String(e.data || '').slice(0, 4)}</PeriodYear>`,
      `          <TransactionID>${esc(e.id)}</TransactionID>`,
      `          <TransactionDate>${date}</TransactionDate>`,
      `          <PaymentMethod>${paymentMethod(e)}</PaymentMethod>`,
      `          <Description>${esc(e.tipNume + (e.partener ? ' - ' + e.partener : ''))}</Description>`,
      lines.join('\n'),
      '          <PaymentDocumentTotals>',
      `            <NetTotal>${num2(total)}</NetTotal>`,
      `            <GrossTotal>${num2(total)}</GrossTotal>`,
      '          </PaymentDocumentTotals>',
      '        </Payment>',
    );
  }
  return [
    '    <Payments>',
    `      <NumberOfEntries>${pays.length}</NumberOfEntries>`,
    `      <TotalDebit>${num2(totalD)}</TotalDebit>`,
    `      <TotalCredit>${num2(totalC)}</TotalCredit>`,
    out.join('\n'),
    '    </Payments>',
  ].join('\n');
}

function sourceDocuments(db, year) {
  // A (Active): documente-sursa dezactivate + AssetTransactions cu contor;
  // C (Stocuri): la fel, dar FARA AssetTransactions si cu MovementOfGoods PLIN
  if (!saftIsPeriodic(year)) {
    return ['  <SourceDocuments>', '    <SalesInvoices/>', '    <PurchaseInvoices/>',
      '    <Payments/>',
      db._saftTip === 'C' ? movementOfGoodsXml(db, year) : '    <MovementOfGoods/>',
      db._saftTip === 'C' ? '' : '    <AssetTransactions><NumberOfAssetTransactions>0</NumberOfAssetTransactions></AssetTransactions>',
      '  </SourceDocuments>'].filter(Boolean).join('\n');
  }
  const roles = partnerRoles(db, year);
  const idOf = (list) => {
    const m = new Map();
    list.forEach((p) => m.set((p.den || '').toUpperCase().trim(), '00' + String(p.cui || '').replace(/^ro/i, '').replace(/\s/g, '')));
    return m;
  };
  const custId = idOf(roles.customers);
  const supId = idOf(roles.suppliers);
  const within = postedEntries(db).filter((e) => inYear(e, year));

  const block = (tag, filter, kind, partyTag, partyIdTag, idMap, account) => {
    const invs = within.filter(filter);
    let net = 0; const xmls = [];
    for (const e of invs) {
      const pid = idMap.get((e.partener || '').toUpperCase().trim()) || pid00(e, db);
      const r = invoiceXml(e, kind, partyTag, partyIdTag, pid, account);
      xmls.push(r.xml); net = round2(net + r.net);
    }
    return [
      `    <${tag}>`,
      `      <NumberOfEntries>${invs.length}</NumberOfEntries>`,
      `      <TotalDebit>${num2(kind === 'purchase' ? net : 0)}</TotalDebit>`,
      `      <TotalCredit>${num2(kind === 'sale' ? net : 0)}</TotalCredit>`,
      xmls.join('\n'),
      `    </${tag}>`,
    ].join('\n');
  };

  return [
    '  <SourceDocuments>',
    block('SalesInvoices', (e) => SALE_TIP(e.tip), 'sale', 'CustomerInfo', 'CustomerID', custId, '4111'),
    block('PurchaseInvoices', (e) => PURCHASE_TIP(e.tip), 'purchase', 'SupplierInfo', 'SupplierID', supId, '401'),
    paymentsXml(db, year),
    movementOfGoodsXml(db, year),
    '  </SourceDocuments>',
  ].join('\n');
}

// Varianta asincrona a sourceDocuments: cedeaza in bucla de facturi (blocul dominant din sectiune).
// Wrapper-ul si invoiceXml sunt aceleasi ca la calea sincrona -> output byte-identic.
async function sourceDocumentsAsync(db, year) {
  // A (Active): documente-sursa dezactivate + AssetTransactions cu contor;
  // C (Stocuri): la fel, dar FARA AssetTransactions si cu MovementOfGoods PLIN
  if (!saftIsPeriodic(year)) {
    return ['  <SourceDocuments>', '    <SalesInvoices/>', '    <PurchaseInvoices/>',
      '    <Payments/>',
      db._saftTip === 'C' ? movementOfGoodsXml(db, year) : '    <MovementOfGoods/>',
      db._saftTip === 'C' ? '' : '    <AssetTransactions><NumberOfAssetTransactions>0</NumberOfAssetTransactions></AssetTransactions>',
      '  </SourceDocuments>'].filter(Boolean).join('\n');
  }
  const roles = partnerRoles(db, year);
  const idOf = (list) => {
    const m = new Map();
    list.forEach((p) => m.set((p.den || '').toUpperCase().trim(), '00' + String(p.cui || '').replace(/^ro/i, '').replace(/\s/g, '')));
    return m;
  };
  const custId = idOf(roles.customers);
  const supId = idOf(roles.suppliers);
  const within = postedEntries(db).filter((e) => inYear(e, year));
  const blockAsync = async (tag, filter, kind, partyTag, partyIdTag, idMap, account) => {
    const invs = within.filter(filter);
    let net = 0; const xmls = []; let i = 0;
    for (const e of invs) {
      const pid = idMap.get((e.partener || '').toUpperCase().trim()) || pid00(e, db);
      const r = invoiceXml(e, kind, partyTag, partyIdTag, pid, account);
      xmls.push(r.xml); net = round2(net + r.net);
      if ((i += 1) % SAFT_YIELD_EVERY === 0) await microYield();
    }
    return [
      `    <${tag}>`,
      `      <NumberOfEntries>${invs.length}</NumberOfEntries>`,
      `      <TotalDebit>${num2(kind === 'purchase' ? net : 0)}</TotalDebit>`,
      `      <TotalCredit>${num2(kind === 'sale' ? net : 0)}</TotalCredit>`,
      xmls.join('\n'),
      `    </${tag}>`,
    ].join('\n');
  };
  const sales = await blockAsync('SalesInvoices', (e) => SALE_TIP(e.tip), 'sale', 'CustomerInfo', 'CustomerID', custId, '4111');
  const purch = await blockAsync('PurchaseInvoices', (e) => PURCHASE_TIP(e.tip), 'purchase', 'SupplierInfo', 'SupplierID', supId, '401');
  return [
    '  <SourceDocuments>',
    sales,
    purch,
    paymentsXml(db, year),
    movementOfGoodsXml(db, year),
    '  </SourceDocuments>',
  ].join('\n');
}

/** Genereaza fisierul SAF-T (D406) pentru un an. */
function saftXml(db, year, tip) {
  // tip: implicit L (perioada 'YYYY-MM') sau A (an); 'C' = declaratia de STOCURI (la cerere)
  if (tip === 'C') db = Object.assign(Object.create(db), { _saftTip: 'C', company: Object.assign({}, db.company, { _saftTip: 'C' }) });
  const yr = String(year || new Date().getFullYear());
  const company = db.company || {};
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<AuditFile xmlns="mfp:anaf:dgti:d406:declaratie:v1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    header(company, yr),
    masterFiles(db, yr),
    generalLedgerEntries(db, yr),
    sourceDocuments(db, yr),
    '</AuditFile>',
    '',
  ].join('\n');
}

/** Varianta ASINCRONA a saftXml: output byte-identic, dar cedeaza event loop-ul periodic in buclele
 *  grele (GL + facturi) — nu blocheaza celelalte cereri la volume mari. Ruta o foloseste in locul
 *  celei sincrone; saftXml sincron ramane pentru teste (referinta byte-identica) si apeluri simple. */
async function saftXmlAsync(db, year, tip) {
  if (tip === 'C') db = Object.assign(Object.create(db), { _saftTip: 'C', company: Object.assign({}, db.company, { _saftTip: 'C' }) });
  const yr = String(year || new Date().getFullYear());
  const company = db.company || {};
  const gl = await generalLedgerEntriesAsync(db, yr);
  const sd = await sourceDocumentsAsync(db, yr);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<AuditFile xmlns="mfp:anaf:dgti:d406:declaratie:v1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    header(company, yr),
    masterFiles(db, yr),
    gl,
    sd,
    '</AuditFile>',
    '',
  ].join('\n');
}

/** Sumar pentru UI (fara a genera tot XML-ul). */
function saftSummary(db, year) {
  const yr = String(year || new Date().getFullYear());
  const within = postedEntries(db).filter((e) => inYear(e, yr));
  let total = 0;
  for (const e of within) for (const l of e.lines) total = round2(total + l.suma);
  const roles = partnerRoles(db, yr);
  return {
    year: yr,
    accounts: accountBalances(db, yr).length,
    entries: within.length,
    totalDebit: total,
    customers: roles.customers.length,
    suppliers: roles.suppliers.length,
    salesInvoices: within.filter((e) => SALE_TIP(e.tip)).length,
    purchaseInvoices: within.filter((e) => PURCHASE_TIP(e.tip)).length,
    payments: within.filter((e) => PAYMENT_TIP(e.tip)).length,
    assets: (db.assets || []).length,
    products: (db.products || []).length,
    stockMovements: (db.stockMovements || []).filter((m) => inYear({ data: m.data }, yr)).length,
  };
}

module.exports = { saftXml, saftXmlAsync, saftSummary, accountBalances, partnerRoles };
