const e = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const inr = n => Number(n).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2});
const displayDate = s => String(s).slice(0,10).split('-').reverse().join('-');

export function amountWords(amount) {
  const short = 'Zero One Two Three Four Five Six Seven Eight Nine Ten Eleven Twelve Thirteen Fourteen Fifteen Sixteen Seventeen Eighteen Nineteen'.split(' ');
  const tens = '  Twenty Thirty Forty Fifty Sixty Seventy Eighty Ninety'.split(' ');
  function read(n) {
    if (n < 20) return short[n];
    if (n < 100) return tens[Math.floor(n/10)] + (n%10 ? ' '+short[n%10] : '');
    for (const [weight,label] of [[10000000,'Crore'],[100000,'Lakh'],[1000,'Thousand'],[100,'Hundred']]) {
      if (n >= weight) return read(Math.floor(n/weight))+' '+label+(n%weight?' '+read(n%weight):'');
    }
  }
  const paise = Math.round(Number(amount)*100);
  return 'Rupees '+read(Math.floor(paise/100))+(paise%100 ? ' and '+read(paise%100)+' Paise' : '')+' Only';
}

const styles = `
@page{size:A4;margin:14mm}
body{font:12px Arial,sans-serif;max-width:190mm;margin:20px auto;color:#111;padding:0 12px}
h1,h2,p{margin:4px 0}h1{font-size:22px}h2{font-size:15px}
.center{text-align:center}.split{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.border,.split>div{border:1px solid #777;padding:8px}
table{border-collapse:collapse;width:100%;margin:9px 0}td,th{border:1px solid #777;padding:6px;text-align:left;vertical-align:top}
.num{text-align:right;white-space:nowrap}thead{display:table-header-group}tr{break-inside:avoid}
.block{break-inside:avoid;margin:9px 0}.sign{padding-top:35px;text-align:right}
.top{display:flex;justify-content:space-between}.actions{margin:12px 0}.actions button{padding:8px}
@media print{body{margin:0;padding:0}.actions{display:none}}
@page invoice { size: A4; margin: 6mm; }
body.invoice-print { page: invoice; max-width: 198mm; }
.invoice-frame { border: 1px solid #111; font: 10px/1.35 "Courier New", monospace; overflow-wrap: anywhere; }
.invoice-frame h1, .invoice-frame h2, .invoice-frame p { margin: 0; }
.invoice-heading { padding: 1.5mm; }
.invoice-heading h1 { font-size: 17px; letter-spacing: .14em; }
.invoice-heading h2 { font-size: 12px; letter-spacing: .15em; text-decoration: underline; }
.invoice-heading .copy { font: italic 11px Georgia, serif; }
.invoice-row { display: table; table-layout: fixed; width: 100%; border-top: 1px solid #111; break-inside: avoid; }
.invoice-row > div { display: table-cell; vertical-align: top; padding: 1.4mm; }
.invoice-row > div + div { border-left: 1px solid #111; }
.invoice-recipient { min-height: 29mm; display: flex; flex-direction: column; }
.invoice-recipient strong { font: bold italic 13px Georgia, serif; }
.invoice-recipient .gstin { margin-top: auto; padding-top: 3mm; }
.invoice-frame table { margin: 0; }
.invoice-items { table-layout: fixed; border-top: 1px solid #111; }
.invoice-items th, .invoice-items td { border: 0; border-right: 1px solid #111; padding: .9mm; }
.invoice-items th { border-bottom: 1px solid #111; }
.invoice-items tr > :last-child { border-right: 0; }
.invoice-items .invoice-filler td { padding: 0; }
.invoice-items .invoice-grand td { border-top: 1px solid #111; font-weight: bold; padding: 1.6mm 1mm; }
.invoice-items .invoice-grand td:first-child { border-right: 0; }
.invoice-items .invoice-grand .invoice-total { border-left: 1px solid #111; }
.invoice-tax { padding: 1mm 1.5mm 2mm; break-inside: avoid; }
.invoice-tax table { width: auto; font-size: 8.5px; }
.invoice-tax th, .invoice-tax td { border: 0; padding: 0 1.5mm .4mm 0; white-space: nowrap; }
.invoice-tax th { border-bottom: 1px solid #111; }
.invoice-tax .invoice-words { margin-top: 2mm; }
.invoice-bank { border-top: 1px solid #111; padding: 1.5mm; break-inside: avoid; }
.invoice-terms { font-size: 9px; }
.invoice-terms ol { margin: 1mm 0 0; padding-left: 4mm; }
.invoice-row .invoice-signatures { padding: 0; }
.invoice-signatures > div { padding: 1.4mm; }
.invoice-signatures .receiver { min-height: 10mm; border-bottom: 1px solid #111; }
.invoice-signatures .authorised { min-height: 18mm; text-align: right; }
.invoice-signatures .authorised p + p { margin-top: 7mm; }

`;

function documentWindow(title,body,bodyClass = '') {
  const win = window.open('','_blank');
  if (!win) { window.alert('Allow pop-ups to open the printable document.'); return; }
  win.opener = null;
  win.document.write('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>'+e(title)+'</title><style>'+styles+'</style></head><body class="'+e(bodyClass)+'"><div class="actions"><button type="button">Print / Save as PDF</button></div>'+body+'</body></html>');
  win.document.close();
  win.document.querySelector('button').onclick = () => win.print();
}

export function printInvoice(bill) {
  const issuer = bill.issuer;
  const recipient = label => '<div><div class="invoice-recipient"><strong>'+label+'</strong>'+
    '<p>'+e(bill.customer_name)+'<br>'+e(bill.service_address)+'</p>'+
    '<p class="gstin">GSTIN / UIN : '+e(bill.customer_gstin)+'</p></div></div>';
  const taxes = new Map();
  for (const l of bill.lines) {
    const tax = taxes.get(l.tax_rate) || {amount:0,cgst:0,sgst:0};
    for (const field of ['amount','cgst','sgst']) tax[field] += Number(l[field]);
    taxes.set(l.tax_rate,tax);
  }
  const totalTax = Number(bill.cgst)+Number(bill.sgst);
  const discount = Number(bill.discount_amount);
  const summaryRow = (label, amount) => '<tr class="invoice-grand"><td colspan="6" class="num">'+label+'</td><td class="num invoice-total">'+amount+'</td></tr>';
  const discountRows = discount > 0 ? summaryRow('Total before discount (incl. GST)',inr(bill.gross_total))+
    summaryRow('Discount ('+inr(bill.discount_percent)+'%)','−'+inr(discount)) : '';
  const rounding = Number(bill.rounding_adjustment);
  const fillerHeight = Math.max(0, 116 - bill.lines.length * 5 - (discountRows ? 10 : 0) - (rounding ? 5 : 0));
  const filler = fillerHeight ? '<tr class="invoice-filler" aria-hidden="true" style="height:'+fillerHeight+'mm">'+'<td></td>'.repeat(7)+'</tr>' : '';
  documentWindow('Invoice '+bill.number,
    '<main class="invoice-frame"><header class="invoice-heading">'+
    '<div class="top"><strong>GSTIN : '+e(issuer.gstin)+'</strong><span class="copy">Original Copy</span></div>'+
    '<div class="center"><h2>TAX INVOICE</h2><h1>'+e(issuer.name)+'</h1><p>'+e(issuer.address)+'</p>'+
    '<p>'+e(issuer.tagline || '')+'</p><p>'+[issuer.phone,issuer.email].filter(Boolean).map(e).join(' · ')+'</p></div></header>'+
    '<div class="invoice-row"><div>Invoice No. : <strong>'+e(bill.number)+'</strong><br>Dated : '+e(displayDate(bill.issued_on))+'</div>'+
    '<div>Place of Supply : Chhattisgarh (22)<br>Reverse Charge : N</div></div>'+
    '<div class="invoice-row">'+recipient('Billed to :')+recipient('Shipped to :')+'</div>'+
    '<table class="invoice-items"><colgroup><col style="width:5.5%"><col style="width:42%"><col style="width:9%"><col style="width:9%"><col style="width:7.5%"><col style="width:12%"><col style="width:15%"></colgroup>'+
    '<thead><tr><th>S.N.</th><th>Description of Goods / Services</th><th>HSN/SAC<br>Code</th><th class="num">Qty.</th><th>Unit</th><th class="num">Price</th><th class="num">Amount (₹)</th></tr></thead><tbody>'+
    bill.lines.map((l,i)=>'<tr><td class="num">'+(i+1)+'.</td><td>'+e(l.description)+'</td><td>'+e(l.hsn_sac)+'</td><td class="num">'+e(l.quantity)+'</td><td>'+e(l.uom)+'</td><td class="num">'+inr(l.unit_price)+'</td><td class="num">'+inr(l.base_before_discount ?? l.amount)+'</td></tr>').join('')+
    filler+discountRows+summaryRow('Grand Total','₹ '+inr(bill.total))+'</tbody></table>'+
    '<div class="invoice-tax"><table><thead><tr><th>Tax Rate</th><th>Taxable Amt.</th><th>CGST Amt.</th><th>SGST Amt.</th><th>Total Tax</th></tr></thead><tbody>'+
    [...taxes.entries()].map(([rate,t])=>'<tr><td>'+e(rate)+'%</td><td class="num">'+inr(t.amount)+'</td><td class="num">'+inr(t.cgst)+'</td><td class="num">'+inr(t.sgst)+'</td><td class="num">'+inr(t.cgst+t.sgst)+'</td></tr>').join('')+
    '<tr><th>Total</th><td class="num">'+inr(bill.subtotal)+'</td><td class="num">'+inr(bill.cgst)+'</td><td class="num">'+inr(bill.sgst)+'</td><td class="num">'+inr(totalTax)+'</td></tr></tbody></table>'+
    (rounding ? '<p>Rounding adjustment to taxable amount plus GST: ₹ '+inr(rounding)+'</p>' : '')+
    '<p class="invoice-words"><strong>'+e(amountWords(bill.total))+'</strong></p></div>'+
    '<div class="invoice-bank"><strong>Bank Details :</strong> '+e(issuer.bank)+'<br>Account No. : '+e(issuer.account)+' · IFSC : '+e(issuer.ifsc)+'</div>'+
    '<div class="invoice-row"><div class="invoice-terms"><strong>Terms &amp; Conditions</strong><br>E.&amp; O.E.<ol><li>Goods once sold will not be taken back.</li><li>Interest @ 18% p.a. will be charged if the payment is not made within the stipulated time.</li><li>Subject to Ambikapur jurisdiction only.</li></ol></div>'+
    '<div class="invoice-signatures"><div class="receiver">Receiver’s Signature :</div><div class="authorised"><p>For '+e(issuer.name)+'</p><p><strong>Authorised Signatory</strong></p></div></div></div></main>',
    'invoice-print');
}

export function printPurchase(order) {
  documentWindow('Purchase order '+order.po_number,'<div class="center"><h1>Purchase Order</h1><p>Jyoti Service Unit</p></div>'+
    '<div class="split"><div>PO #'+e(order.po_number)+'<br>Date '+displayDate(order.created_at)+'</div><div>Supplier<br><strong>'+e(order.suppliers.name)+'</strong></div></div>'+
    '<table><thead><tr><th>Part</th><th>Quantity</th><th>UOM</th><th>Unit price</th><th>Amount (₹)</th></tr></thead><tbody>'+
    order.purchase_lines.map(l=>'<tr><td>'+e(l.description)+'</td><td>'+e(l.quantity)+'</td><td>'+e(l.uom)+'</td><td>'+inr(l.unit_price)+'</td><td>'+inr(l.unit_price*l.quantity)+'</td></tr>').join('')+
    '<tr><th colspan="4">Total</th><th>'+inr(order.purchase_lines.reduce((sum,l)=>sum+Math.round(l.unit_price*l.quantity*100)/100,0))+'</th></tr></tbody></table>');
}
