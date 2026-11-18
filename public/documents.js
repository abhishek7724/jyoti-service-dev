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
`;

function documentWindow(title,body) {
  const win = window.open('','_blank');
  if (!win) { window.alert('Allow pop-ups to open the printable document.'); return; }
  win.opener = null;
  win.document.write('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>'+e(title)+'</title><style>'+styles+'</style></head><body><div class="actions"><button type="button">Print / Save as PDF</button></div>'+body+'</body></html>');
  win.document.close();
  win.document.querySelector('button').onclick = () => win.print();
}

export function printInvoice(bill) {
  const issuer = bill.issuer;
  const recipient = '<strong>'+e(bill.customer_name)+'</strong><br>'+e(bill.service_address)+'<p>GSTIN / UIN '+e(bill.customer_gstin)+'</p>';
  const taxes = new Map();
  for (const l of bill.lines) {
    const tax = taxes.get(l.tax_rate) || {amount:0,cgst:0,sgst:0};
    for (const field of ['amount','cgst','sgst']) tax[field] += Number(l[field]);
    taxes.set(l.tax_rate,tax);
  }
  const totalTax = Number(bill.cgst)+Number(bill.sgst);
  documentWindow('Invoice '+bill.number,
    '<div class="top"><strong>GSTIN '+e(issuer.gstin)+'</strong><strong>Original Copy</strong></div>'+
    '<div class="center"><h2>TAX INVOICE</h2><h1>'+e(issuer.name)+'</h1><p>'+e(issuer.address)+'</p>'+
    '<p>'+e(issuer.tagline || '')+'</p><p>'+[issuer.phone,issuer.email].filter(Boolean).map(e).join(' · ')+'</p></div>'+
    '<div class="split block"><div>Invoice No. <strong>'+e(bill.number)+'</strong><br>Dated '+displayDate(bill.issued_on)+'</div>'+
    '<div>Place of Supply: Chhattisgarh (22)<br>Reverse Charge: N</div></div>'+
    '<div class="split block"><div>Billed to<br>'+recipient+'</div><div>Shipped to<br>'+recipient+'</div></div>'+
    '<table><thead><tr><th>S.N.</th><th>Description of Goods / Services</th><th>HSN/SAC</th><th>Qty.</th><th>Unit</th><th class="num">Price</th><th class="num">Amount (₹)</th></tr></thead><tbody>'+
    bill.lines.map((l,i)=>'<tr><td>'+(i+1)+'</td><td>'+e(l.description)+'</td><td>'+e(l.hsn_sac)+'</td><td>'+e(l.quantity)+'</td><td>'+e(l.uom)+'</td><td class="num">'+inr(l.unit_price)+'</td><td class="num">'+inr(l.amount)+'</td></tr>').join('')+
    '<tr><th colspan="6" class="num">Grand Total</th><th class="num">₹ '+inr(bill.total)+'</th></tr></tbody></table>'+
    '<div class="block"><table><thead><tr><th>Tax Rate</th><th>Taxable Amt.</th><th>CGST Amt.</th><th>SGST Amt.</th><th>Total Tax</th></tr></thead><tbody>'+
    [...taxes.entries()].map(([rate,t])=>'<tr><td>'+e(rate)+'%</td><td>'+inr(t.amount)+'</td><td>'+inr(t.cgst)+'</td><td>'+inr(t.sgst)+'</td><td>'+inr(t.cgst+t.sgst)+'</td></tr>').join('')+
    '<tr><th>Total</th><th>'+inr(bill.subtotal)+'</th><th>'+inr(bill.cgst)+'</th><th>'+inr(bill.sgst)+'</th><th>'+inr(totalTax)+'</th></tr></tbody></table>'+
    '<p><strong>'+e(amountWords(bill.total))+'</strong></p><p>Bank Details '+e(issuer.bank)+'<br>Account No. '+e(issuer.account)+' · IFSC '+e(issuer.ifsc)+'</p></div>'+
    '<div class="split block"><div><strong>Terms &amp; Conditions</strong><br>E.&amp; O.E.<ol><li>Goods once sold will not be taken back.</li><li>Interest @ 18% p.a. will be charged if the payment is not made within the stipulated time.</li><li>Subject to Ambikapur jurisdiction only.</li></ol></div>'+
    '<div><strong>Receiver’s Signature</strong><p class="sign">For '+e(issuer.name)+'</p><p class="sign">Authorised Signatory</p></div></div>');
}

export function printPurchase(order) {
  documentWindow('Purchase order '+order.po_number,'<div class="center"><h1>Purchase Order</h1><p>Jyoti Service Unit</p></div>'+
    '<div class="split"><div>PO #'+e(order.po_number)+'<br>Date '+displayDate(order.created_at)+'</div><div>Supplier<br><strong>'+e(order.suppliers.name)+'</strong></div></div>'+
    '<table><thead><tr><th>Part</th><th>Quantity</th><th>UOM</th><th>Unit price</th><th>Amount (₹)</th></tr></thead><tbody>'+
    order.purchase_lines.map(l=>'<tr><td>'+e(l.description)+'</td><td>'+e(l.quantity)+'</td><td>'+e(l.uom)+'</td><td>'+inr(l.unit_price)+'</td><td>'+inr(l.unit_price*l.quantity)+'</td></tr>').join('')+
    '<tr><th colspan="4">Total</th><th>'+inr(order.purchase_lines.reduce((sum,l)=>sum+Math.round(l.unit_price*l.quantity*100)/100,0))+'</th></tr></tbody></table>');
}
