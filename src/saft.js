'use strict';

// Generator SAF-T (D406) — fisierul standard de audit fiscal cerut de ANAF.
// Produce un XML bine-format, aliniat la structura OECD SAF-T 2.0 adaptata RO,
// cu Header + MasterFiles (conturi, clienti, furnizori, cote TVA) + GeneralLedgerEntries.
// Nota: validarea oficiala ANAF necesita schema XSD D406 si, dupa caz, sectiunile
// SourceDocuments / Assets / Stocks (conditionate). Acopera nucleul contabil (GL).

const { round2 } = require('./util');
const coa = require('./chartOfAccounts');
const fiscal = require('./fiscal');
const assetsLib = require('./assets');

// Generarea la volume mari (zeci de mii de articole) e CPU-bound si ar bloca event loop-ul cateva
// sute de ms — adica ar ingheta TOATE celelalte cereri cat timp ruleaza. Variantele *Async cedeaza
// event loop-ul la fiecare SAFT_YIELD_EVERY iteratii (fara infra, fara worker), pastrand output-ul
// byte-identic cu cel sincron. La volume mici (productia normala) yield-ul e neglijabil.
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
function inYear(e, p) { const s = String(e.period || e.data || ''); const q = String(p); return q.length === 7 ? s.slice(0, 7) === q : s.slice(0, 4) === q; }
function beforeYear(e, p) { const s = String(e.period || e.data || ''); const q = String(p); return q.length === 7 ? s.slice(0, 7) < q : s.slice(0, 4) < q; }

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
  const before = accumulate((db.entries || []).filter((e) => beforeYear(e, year)));
  const within = accumulate((db.entries || []).filter((e) => inYear(e, year)));
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
  for (const e of (db.entries || [])) {
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
    `${pad}<Region>${esc(p.judet || 'RO')}</Region>`,
    `${pad}<Country>${esc(p.tara || 'RO')}</Country>`,
  ].join('\n');
}

function header(company, year) {
  const now = new Date().toISOString().slice(0, 10);
  return [
    '  <Header>',
    '    <AuditFileVersion>2.4.8</AuditFileVersion>',
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
    `      <PeriodStart>${String(year).length === 7 ? Number(String(year).slice(5, 7)) : 1}</PeriodStart>`,
    `      <PeriodStartYear>${String(year).slice(0, 4)}</PeriodStartYear>`,
    `      <PeriodEnd>${String(year).length === 7 ? Number(String(year).slice(5, 7)) : 12}</PeriodEnd>`,
    `      <PeriodEndYear>${String(year).slice(0, 4)}</PeriodEndYear>`,
    '    </SelectionCriteria>',
    `    <HeaderComment>${String(year).length === 7 ? 'L' : 'A'}</HeaderComment>`,
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
  list.forEach((p, i) => {
    const info = partnerInfo(db, p.cui);
    // RegistrationNumber in SAF-T: "00" + CUI numeric pentru RO; "01" + cod tara + cod TVA
    // pentru UE (ghidul oficial D406 — prefixul fiscal "RO" NU se scrie)
    const cuiCurat = String(p.cui || '').replace(/\s/g, '');
    const reg = !cuiCurat ? '00' : /^ro/i.test(cuiCurat) || /^\d+$/.test(cuiCurat)
      ? '00' + cuiCurat.replace(/^ro/i, '')
      : '01' + cuiCurat;
    const balD = p.bal >= 0 ? num2(p.bal) : '0.00';
    const balC = p.bal < 0 ? num2(-p.bal) : '0.00';
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

function taxTable() {
  const f = fiscal.FISCAL || {};
  const std = f.tvaStandard || 21;
  const red = f.tvaRedus || 11;
  const rates = [
    { code: 'S', pct: std, desc: 'TVA cota standard' },
    { code: 'R', pct: red, desc: 'TVA cota redusa' },
    { code: 'Z', pct: 0, desc: 'TVA cota zero / scutit' },
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
      '          <BaseRate>100.00</BaseRate>',
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
  list.forEach((a, i) => {
    const cEnd = assetsLib.compute(a, year + '-12');
    const cBegin = assetsLib.compute(a, (Number(year) - 1) + '-12');
    const depYear = round2(cEnd.amortizareCumulata - cBegin.amortizareCumulata);
    out.push(
      '      <Asset>',
      `        <AssetID>${esc(a.id)}</AssetID>`,
      `        <AccountID>${esc(a.cont)}</AccountID>`,
      `        <Description>${esc(a.denumire)}</Description>`,
      `        <SupplierName>${esc(a.furnizor || 'N/A')}</SupplierName>`,
      `        <DateOfAcquisition>${esc(a.dataAchizitie || a.dataPif)}</DateOfAcquisition>`,
      `        <StartUpDate>${esc(a.dataPif)}</StartUpDate>`,
      `        <AssetLifeNumberOfYear>${num2((a.durataLuni || 0) / 12)}</AssetLifeNumberOfYear>`,
      '        <AssetValuations>',
      '          <AssetValuation>',
      '            <AssetValuationType>CST</AssetValuationType>',
      `            <AcquisitionAndProductionCostsBegin>${num2(a.cost)}</AcquisitionAndProductionCostsBegin>`,
      `            <AcquisitionAndProductionCostsEnd>${num2(a.cost)}</AcquisitionAndProductionCostsEnd>`,
      `            <DepreciationMethod>${a.metoda === 'degresiva' ? 'D' : a.metoda === 'accelerata' ? 'A' : 'L'}</DepreciationMethod>`,
      `            <DepreciationForPeriod>${num2(depYear)}</DepreciationForPeriod>`,
      `            <AccumulatedDepreciation>${num2(cEnd.amortizareCumulata)}</AccumulatedDepreciation>`,
      `            <BookValue>${num2(cEnd.valoareRamasa)}</BookValue>`,
      '          </AssetValuation>',
      '        </AssetValuations>',
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
      `        <ProductNumberCode>${esc(p.codNC || p.cod)}</ProductNumberCode>`,
      '        <ValuationMethod>CMP</ValuationMethod>',
      `        <UOMBase>${esc(p.um || 'buc')}</UOMBase>`,
      `        <UOMStandard>${esc(p.um || 'buc')}</UOMStandard>`,
      '        <UOMToUOMBaseConversionFactor>1</UOMToUOMBaseConversionFactor>',
      '      </Product>',
    );
  }
  out.push('    </Products>');
  return out.join('\n');
}

function physicalStockXml(db, year) {
  const stock = stocksLib.currentStock(db, year + '-12');
  const out = ['    <PhysicalStock>'];
  for (const s of stock) {
    out.push(
      '      <Product>',
      `        <WarehouseID>${esc((s.gestiune && s.gestiune.cod) || 'GEST')}</WarehouseID>`,
      `        <ProductCode>${esc(s.product.cod)}</ProductCode>`,
      `        <StockAccountID>${esc(s.product.cont || '371')}</StockAccountID>`,
      `        <ClosingStockQuantity>${num2(s.stocQ)}</ClosingStockQuantity>`,
      `        <UnitOfMeasure>${esc(s.product.um || 'buc')}</UnitOfMeasure>`,
      `        <ClosingStockValue>${num2(s.stocV)}</ClosingStockValue>`,
      `        <UnitPrice>${num2(s.cmp)}</UnitPrice>`,
      '      </Product>',
    );
  }
  out.push('    </PhysicalStock>');
  return out.join('\n');
}

/** UOMTable — unitatile de masura folosite in nomenclatorul de produse (cerut de XSD D406). */
function uomTable(db) {
  const ums = [...new Set((db.products || []).map((p) => String(p.um || 'buc').trim()).filter(Boolean))].sort();
  if (!ums.length) ums.push('buc');
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
  const TYPES = [
    ['Receptie', 'Intrare in gestiune (receptie / NIR / plus de inventar)'],
    ['Iesire', 'Iesire din gestiune (consum / vanzare / minus de inventar)'],
    ['Transfer', 'Transfer intre gestiuni (miscare interna)'],
  ];
  const out = ['    <MovementTypeTable>'];
  for (const [t, d] of TYPES) {
    out.push('      <MovementTypeTableEntry>',
      `        <MovementType>${t}</MovementType>`,
      `        <Description>${d}</Description>`,
      '      </MovementTypeTableEntry>');
  }
  out.push('    </MovementTypeTable>');
  return out.join('\n');
}

/** Owners — asociatii/actionarii firmei (Setari -> Datele firmei, un rand pe asociat:
 *  "Nume; CNP/CUI; procent"). Pentru PFA fara lista: titularul cu 100%. */
function ownersXml(db) {
  const c = db.company || {};
  const rows = String(c.asociatiText || '').trim()
    ? String(c.asociatiText).trim().split(/\r?\n/).map((l) => l.split(';').map((s) => s.trim())).filter((a) => a[0])
    : (c.tipEntitate === 'pfa' ? [[c.nume || 'Titular', String(c.cui || ''), '100']] : []);
  if (!rows.length) return '';
  const out = ['    <Owners>'];
  rows.forEach((a, i) => out.push('      <Owner>',
    `        <OwnerID>${i + 1}</OwnerID>`,
    `        <AccountID>456</AccountID>`,
    `        <RegistrationNumber>${esc(a[1] || '')}</RegistrationNumber>`,
    `        <Name>${esc(a[0])}</Name>`,
    `        <SharesQuantity>${esc((a[2] || '').replace('%', ''))}</SharesQuantity>`,
    '      </Owner>'));
  out.push('    </Owners>');
  return out.join('\n');
}

function masterFiles(db, year) {
  const roles = partnerRoles(db, year);
  return [
    '  <MasterFiles>',
    generalLedgerAccounts(db, year),
    partyXml('Customer', 'CustomerID', '4111', roles.customers, db),
    partyXml('Supplier', 'SupplierID', '401', roles.suppliers, db),
    taxTable(),
    uomTable(db),
    '    <AnalysisTypeTable/>',
    productsXml(db),
    assetsXml(db, year),
    physicalStockXml(db, year),
    ownersXml(db),
    '  </MasterFiles>',
  ].filter(Boolean).join('\n');
}

function movementOfGoodsXml(db, year) {
  const byId = new Map((db.products || []).map((p) => [p.id, p]));
  const gCod = new Map((db.gestiuni || []).map((g) => [g.id, g.cod]));
  const movs = stocksLib.sortMov((db.stockMovements || []).filter((m) => inYear({ data: m.data }, year)));
  let qIn = 0; let qOut = 0; const lines = [];
  movs.forEach((m, i) => {
    const p = byId.get(m.productId) || {};
    const c = round2(Number(m.cantitate) || 0);
    const type = m.tip === 'receptie' ? 'Receptie' : m.tip === 'transfer' ? 'Transfer' : 'Iesire';
    if (m.tip === 'receptie') qIn = round2(qIn + c);
    else if (m.tip === 'iesire') qOut = round2(qOut + c); // transferurile = interne, nu in totaluri
    const wh = gCod.get(m.gestiuneId) || 'GEST';
    lines.push(
      '        <StockMovement>',
      `          <MovementReference>${esc(m.document || m.id)}</MovementReference>`,
      `          <MovementDate>${esc(m.data)}</MovementDate>`,
      `          <MovementType>${type}</MovementType>`,
      '          <StockMovementLine>',
      `            <LineNumber>${i + 1}</LineNumber>`,
      `            <ProductCode>${esc(p.cod || m.productId)}</ProductCode>`,
      `            <Description>${esc(p.denumire || '')}</Description>`,
      `            <Quantity>${num2(c)}</Quantity>`,
      `            <UnitOfMeasure>${esc(p.um || 'buc')}</UnitOfMeasure>`,
      `            <WarehouseID>${esc(wh)}</WarehouseID>`,
      ...(m.tip === 'transfer' ? [`            <WarehouseIDTo>${esc(gCod.get(m.gestiuneDestId) || 'GEST')}</WarehouseIDTo>`] : []),
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
function glTx(e, year) {
  const month = Number(String(e.period || e.data).slice(5, 7)) || 1;
  const sysDate = String(e.data);
  let rec = 0;
  const lines = [];
  for (const l of e.lines) {
    rec += 1;
    lines.push(
      '          <Line>',
      `            <RecordID>${esc(e.id)}-${rec}D</RecordID>`,
      `            <AccountID>${esc(l.debit)}</AccountID>`,
      `            <Description>${esc(l.explicatie || e.explicatie || e.tipNume)}</Description>`,
      `            <DebitAmount><Amount>${num2(l.suma)}</Amount></DebitAmount>`,
      '          </Line>',
    );
    rec += 1;
    lines.push(
      '          <Line>',
      `            <RecordID>${esc(e.id)}-${rec}C</RecordID>`,
      `            <AccountID>${esc(l.credit)}</AccountID>`,
      `            <Description>${esc(l.explicatie || e.explicatie || e.tipNume)}</Description>`,
      `            <CreditAmount><Amount>${num2(l.suma)}</Amount></CreditAmount>`,
      '          </Line>',
    );
  }
  return [
    '        <Transaction>',
    `          <TransactionID>${esc(e.id)}</TransactionID>`,
    `          <Period>${month}</Period>`,
    `          <PeriodYear>${year}</PeriodYear>`,
    `          <TransactionDate>${sysDate}</TransactionDate>`,
    `          <Description>${esc(e.tipNume + (e.document ? ' ' + e.document : ''))}</Description>`,
    `          <SystemEntryDate>${sysDate}</SystemEntryDate>`,
    `          <GLPostingDate>${sysDate}</GLPostingDate>`,
    lines.join('\n'),
    '        </Transaction>',
  ];
}
function glEntriesSorted(db, year) {
  return (db.entries || []).filter((e) => inYear(e, year))
    .sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : String(a.id).localeCompare(String(b.id))));
}
function glWrap(entries, year, txs) {
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
  for (const e of entries) txs.push(glTx(e, year).join('\n'));
  return glWrap(entries, year, txs);
}
// Varianta asincrona: cedeaza event loop-ul periodic (bucla dominanta la volume mari). Output
// byte-identic cu cel sincron (acelasi glTx/glWrap) — verificat in teste.
async function generalLedgerEntriesAsync(db, year) {
  const entries = glEntriesSorted(db, year);
  const txs = [];
  let i = 0;
  for (const e of entries) {
    txs.push(glTx(e, year).join('\n'));
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
  const invType = /storno/.test(e.tip) ? 'NC' : 'FT';
  const out = [
    '      <Invoice>',
    `        <InvoiceNo>${esc(e.document || e.id)}</InvoiceNo>`,
    `        <${partyTag}>`,
    `          <${partyIdTag}>${esc(partyId)}</${partyIdTag}>`,
    '          <BillingAddress>',
    addressXml({}, '            '),
    '            <AddressType>StreetAddress</AddressType>',
    '          </BillingAddress>',
    `          <AccountID>${defaultAccount}</AccountID>`,
    `        </${partyTag}>`,
    `        <Period>${month}</Period>`,
    `        <InvoiceDate>${date}</InvoiceDate>`,
    `        <InvoiceType>${invType}</InvoiceType>`,
    '        <SelfBillingIndicator>0</SelfBillingIndicator>',
    `        <SystemEntryDate>${date}</SystemEntryDate>`,
    `        <TransactionID>${esc(e.id)}</TransactionID>`,
  ];
  for (const l of data.lines) {
    out.push(
      '        <Line>',
      `          <LineNumber>${l.n}</LineNumber>`,
      `          <AccountID>${esc(l.acc)}</AccountID>`,
      `          <ProductDescription>${esc(l.desc)}</ProductDescription>`,
      `          <Quantity>${num2(l.qty)}</Quantity>`,
      `          <UnitOfMeasure>${esc(l.um)}</UnitOfMeasure>`,
      `          <UnitPrice>${num2(l.price)}</UnitPrice>`,
      `          <TaxPointDate>${date}</TaxPointDate>`,
      `          <Description>${esc(l.desc)}</Description>`,
      `          <${amtTag}><Amount>${num2(l.amount)}</Amount></${amtTag}>`,
      '          <Tax>',
      '            <TaxType>300</TaxType>',
      `            <TaxCode>${l.cota >= 19 ? 'S' : l.cota > 0 ? 'R' : 'Z'}</TaxCode>`,
      `            <TaxPercentage>${num2(l.cota)}</TaxPercentage>`,
      `            <TaxAmount><Amount>${num2(l.tax)}</Amount></TaxAmount>`,
      '          </Tax>',
      '        </Line>',
    );
  }
  out.push(
    '        <DocumentTotals>',
    `          <TaxPayable>${num2(data.tax)}</TaxPayable>`,
    `          <NetTotal>${num2(data.net)}</NetTotal>`,
    `          <GrossTotal>${num2(data.total)}</GrossTotal>`,
    '        </DocumentTotals>',
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
    if (acc) return /^53/.test(acc) ? 'Numerar' : /^512/.test(acc) ? 'Virament' : 'Alte';
  }
  return 'Alte';
}
function paymentsXml(db, year) {
  const pays = (db.entries || []).filter((e) => inYear(e, year) && PAYMENT_TIP(e.tip));
  let totalD = 0; let totalC = 0; const out = [];
  for (const e of pays) {
    const date = String(e.data);
    const month = Number(String(e.period || e.data).slice(5, 7)) || 1;
    let rec = 0; const lines = [];
    for (const l of e.lines) {
      totalD = round2(totalD + l.suma); totalC = round2(totalC + l.suma);
      rec += 1;
      lines.push(
        '          <Line>',
        `            <LineNumber>${rec}</LineNumber>`,
        `            <AccountID>${esc(l.debit)}</AccountID>`,
        `            <Description>${esc(l.explicatie || e.explicatie || e.tipNume)}</Description>`,
        `            <DebitAmount><Amount>${num2(l.suma)}</Amount></DebitAmount>`,
        '          </Line>',
      );
      rec += 1;
      lines.push(
        '          <Line>',
        `            <LineNumber>${rec}</LineNumber>`,
        `            <AccountID>${esc(l.credit)}</AccountID>`,
        `            <Description>${esc(l.explicatie || e.explicatie || e.tipNume)}</Description>`,
        `            <CreditAmount><Amount>${num2(l.suma)}</Amount></CreditAmount>`,
        '          </Line>',
      );
    }
    const total = round2(e.lines.reduce((s, l) => s + l.suma, 0));
    out.push(
      '        <Payment>',
      `          <PaymentRefNo>${esc(e.document || e.id)}</PaymentRefNo>`,
      `          <PaymentRefNo>${esc(e.document || e.id)}</PaymentRefNo>`,
      `          <Period>${month}</Period>`,
      `          <PeriodYear>${String(e.data || '').slice(0, 4)}</PeriodYear>`,
      `          <TransactionID>${esc(e.id)}</TransactionID>`,
      `          <TransactionDate>${date}</TransactionDate>`,
      `          <PaymentMethod>${paymentMethod(e)}</PaymentMethod>`,
      `          <Description>${esc(e.tipNume + (e.partener ? ' - ' + e.partener : ''))}</Description>`,
      lines.join('\n'),
      '          <DocumentTotals>',
      `            <TaxPayable>0.00</TaxPayable>`,
      `            <NetTotal>${num2(total)}</NetTotal>`,
      `            <GrossTotal>${num2(total)}</GrossTotal>`,
      '          </DocumentTotals>',
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
  const roles = partnerRoles(db, year);
  const idOf = (list) => {
    const m = new Map();
    list.forEach((p, i) => m.set((p.den || '').toUpperCase().trim(), 'P' + String(i + 1).padStart(4, '0')));
    return m;
  };
  const custId = idOf(roles.customers);
  const supId = idOf(roles.suppliers);
  const within = (db.entries || []).filter((e) => inYear(e, year));

  const block = (tag, filter, kind, partyTag, partyIdTag, idMap, account) => {
    const invs = within.filter(filter);
    let net = 0; const xmls = [];
    for (const e of invs) {
      const pid = idMap.get((e.partener || '').toUpperCase().trim()) || 'P0001';
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
  const roles = partnerRoles(db, year);
  const idOf = (list) => {
    const m = new Map();
    list.forEach((p, i) => m.set((p.den || '').toUpperCase().trim(), 'P' + String(i + 1).padStart(4, '0')));
    return m;
  };
  const custId = idOf(roles.customers);
  const supId = idOf(roles.suppliers);
  const within = (db.entries || []).filter((e) => inYear(e, year));
  const blockAsync = async (tag, filter, kind, partyTag, partyIdTag, idMap, account) => {
    const invs = within.filter(filter);
    let net = 0; const xmls = []; let i = 0;
    for (const e of invs) {
      const pid = idMap.get((e.partener || '').toUpperCase().trim()) || 'P0001';
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
function saftXml(db, year) {
  const yr = String(year || new Date().getFullYear());
  const company = db.company || {};
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<AuditFile xmlns="mfp:anaf:dgti:d406t:declaratie:v1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
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
async function saftXmlAsync(db, year) {
  const yr = String(year || new Date().getFullYear());
  const company = db.company || {};
  const gl = await generalLedgerEntriesAsync(db, yr);
  const sd = await sourceDocumentsAsync(db, yr);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<AuditFile xmlns="mfp:anaf:dgti:d406t:declaratie:v1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
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
  const within = (db.entries || []).filter((e) => inYear(e, yr));
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
