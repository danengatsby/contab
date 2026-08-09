// ANEXA A — planul de conturi, generat DIN APLICATIE (src/chartOfAccounts.js).
// Nu se scrie de mana: orice cont adaugat in plan apare aici la urmatoarea regenerare.
const fs = require('fs');
const path = require('path');
const coa = require(path.join(__dirname, '../../src/chartOfAccounts'));

const CLASE = {
  1: ['Capitaluri', 'De unde au venit banii care nu trebuie returnați curând: aportul asociaților, profitul rămas în firmă, rezervele, împrumuturile pe termen lung.'],
  2: ['Imobilizări', 'Bunurile folosite mai mult de un an: clădiri, utilaje, mașini, licențe — și amortizarea lor, care le scade valoarea an de an.'],
  3: ['Stocuri', 'Ce se cumpără sau se produce pentru a fi vândut ori consumat: marfă, materii prime, produse finite.'],
  4: ['Terți', 'Relațiile cu ceilalți: clienți, furnizori, salariați, stat. Cea mai mare clasă, fiindcă aici trece aproape tot.'],
  5: ['Trezorerie', 'Banii propriu-ziși: conturile bancare, casieria, viramentele între ele.'],
  6: ['Cheltuieli', 'Ce s-a consumat în perioadă. Se golesc la sfârșitul anului — vezi capitolul 42.'],
  7: ['Venituri', 'Ce s-a câștigat în perioadă. Se golesc și ele la sfârșitul anului.'],
  8: ['Conturi speciale', 'Evidența unor elemente care nu intră în bilanț, dar trebuie urmărite.'],
};
const TIP = { A: 'activ', P: 'pasiv', B: 'bifuncțional', C: 'cheltuieli', V: 'venituri' };
const SENS = { A: 'debitor', C: 'creditor', B: 'oricare' };

const blocuri = [
  { tip: 'p', text: 'Planul de conturi e lista completă a „sertarelor” în care se poate pune o sumă. Anexa aceasta îl reproduce așa cum e folosit în practica unei firme mici și mijlocii, grupat pe cele opt clase, cu sensul normal al soldului fiecărui cont.' },
  { tip: 'p', text: 'Se citește pe verticală, nu de la cap la coadă. Cifra întâi dă clasa, deci natura contului; a doua și a treia îl detaliază. Un cont care începe cu 4 privește o relație cu cineva din afară; unul care începe cu 6 e o cheltuială. Regula aceasta singură lămurește jumătate din întrebările începătorului.' },
  { tip: 'cheie', text: 'Sensul normal al soldului nu e o convenție de memorat, ci o consecință: activele cresc în debit, datoriile și capitalurile în credit. Un sold pe partea greșită e, aproape întotdeauna, o eroare — vezi capitolul 32.' },
];

const list = coa.ACCOUNTS.slice().sort((a, b) => String(a.cod).localeCompare(String(b.cod)));
let total = 0;
for (const cl of [1, 2, 3, 4, 5, 6, 7, 8]) {
  const conturi = list.filter((a) => a.clasa === cl);
  if (!conturi.length) continue;
  const [nume, desc] = CLASE[cl];
  blocuri.push({ tip: 'h', text: `Clasa ${cl} — ${nume}` });
  blocuri.push({ tip: 'p', text: desc });
  blocuri.push({
    tip: 'tabel',
    titlu: `Clasa ${cl}: ${conturi.length} conturi`,
    cap: ['Cont', 'Denumirea', 'Natura', 'Sold normal'],
    randuri: conturi.map((a) => [a.cod, a.nume, TIP[a.tip] || a.tip, SENS[coa.normalSide(a.cod)] || '—']),
  });
  total += conturi.length;
}

blocuri.push({ tip: 'h', text: 'Ce nu conține lista' });
blocuri.push({ tip: 'p', text: 'Planul de mai sus are ' + total + ' de conturi sintetice. Planul general de conturi din reglementările contabile are mai multe: lista aceasta cuprinde conturile pe care le atinge efectiv o firmă mică sau mijlocie, nu întregul nomenclator.' });
blocuri.push({ tip: 'p', text: 'Lipsesc, de asemenea, conturile analitice — desfășurarea pe parteneri, pe gestiuni, pe cote de TVA. Ele nu se enumeră, fiindcă se construiesc de fiecare firmă după nevoile ei, pornind de la contul sintetic. Un „4111.ALFA” e tot un cont 4111; ce se adaugă după punct e organizarea internă, nu planul de conturi.' });
blocuri.push({ tip: 'recap', titlu: 'Cum se folosește anexa', puncte: [
  'Cifra întâi dă clasa, deci natura contului; restul îl detaliază.',
  'Coloana „sold normal” spune pe ce parte se așteaptă soldul; partea opusă e semnal de eroare, nu situație rară.',
  'Conturile bifuncționale (121, 117, 581) pot avea sold pe oricare parte — de aceea au coloana „oricare”.',
  'Analiticele nu apar: ele se construiesc de fiecare firmă, pornind de la sinteticul din listă.',
] });

fs.writeFileSync(path.join(__dirname, '../cuprins-carte-capA.json'),
  JSON.stringify({ parte: 'Anexe · de folosit, nu de citit', nr: 'A', titlu: 'Planul de conturi, pe clase', blocuri }, null, 1), 'utf8');
console.log('  anexa A:', total, 'conturi in', blocuri.filter((b) => b.tip === 'tabel').length, 'tabele');
