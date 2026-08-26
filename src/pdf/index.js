'use strict';

// PDF-urile aplicatiei, sparte pe module tematice (vechiul src/pdf.js monolit).
// Contractul public e neschimbat: aceleasi nume, re-exportate de aici.

const helpers = require('./helpers');
const registre = require('./registre');
const situatii = require('./situatii');
const declaratii = require('./declaratii');
const facturare = require('./facturare');
const stocuri = require('./stocuri');
const imobilizari = require('./imobilizari');
const salarii = require('./salarii');

module.exports = {
  clean: helpers.clean,
  journalPdf: registre.journalPdf, ledgerPdf: registre.ledgerPdf, trialBalancePdf: registre.trialBalancePdf, fisaContPdf: registre.fisaContPdf, cashBookPdf: registre.cashBookPdf, cashValutaPdf: registre.cashValutaPdf, registruIncasariPlatiPdf: registre.registruIncasariPlatiPdf, registruInventarPdf: registre.registruInventarPdf, registruFiscalPdf: registre.registruFiscalPdf, analyticPdf: registre.analyticPdf, agingPdf: registre.agingPdf, aprovizionariPdf: registre.aprovizionariPdf, consumuriPdf: registre.consumuriPdf, docRegisterPdf: registre.docRegisterPdf,
  plPdf: situatii.plPdf, balanceSheetPdf: situatii.balanceSheetPdf, notesPdf: situatii.notesPdf, cashForecast13Pdf: situatii.cashForecast13Pdf, cashFlowPdf: situatii.cashFlowPdf, equityPdf: situatii.equityPdf, setStatementsPdf: situatii.setStatementsPdf,
  vatPdf: declaratii.vatPdf, d112Pdf: declaratii.d112Pdf, d300Pdf: declaratii.d300Pdf, d100Pdf: declaratii.d100Pdf, d394Pdf: declaratii.d394Pdf, saftPdf: declaratii.saftPdf, f4109Pdf: declaratii.f4109Pdf, dosarCmPdf: declaratii.dosarCmPdf, declaratiaUnicaPdf: declaratii.declaratiaUnicaPdf, obligatiiPdf: declaratii.obligatiiPdf,
  facturaPdf: facturare.facturaPdf, chitantaPdf: facturare.chitantaPdf, notePdf: facturare.notePdf,
  stocksPdf: stocuri.stocksPdf, stockLedgerPdf: stocuri.stockLedgerPdf, inventoryListPdf: stocuri.inventoryListPdf, inventoryPvPdf: stocuri.inventoryPvPdf, nirPdf: stocuri.nirPdf, bonConsumPdf: stocuri.bonConsumPdf, avizPdf: stocuri.avizPdf,
  assetsRegisterPdf: imobilizari.assetsRegisterPdf, assetFisaPdf: imobilizari.assetFisaPdf, leasingSchedulePdf: imobilizari.leasingSchedulePdf,
  statePlataPdf: salarii.statePlataPdf, fluturasPdf: salarii.fluturasPdf, registruSalariiPdf: salarii.registruSalariiPdf, adeverintaPdf: salarii.adeverintaPdf,
};
