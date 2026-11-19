import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { amountWords } from '../public/documents.js';

export const money = value => Number(value || 0).toLocaleString('en-IN', {minimumFractionDigits:2, maximumFractionDigits:2});
export const dateLabel = value => String(value).slice(0,10).split('-').reverse().join('-');
export const invoiceFilename = bill => 'Jyoti-Invoice-' + String(bill.number).replace(/[^a-zA-Z0-9_-]/g,'-') + '.pdf';
const text = value => String(value ?? '').replace(/\u20b9/g,'Rs. ').replace(/[\u2018\u2019]/g,"'").replace(/[\u201c\u201d]/g,'"').replace(/[\u2013\u2014]/g,'-');

export async function invoicePdf(bill) {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(.08,.12,.15), green = rgb(.04,.32,.26), line = rgb(.78,.81,.82);
  let page, y;
  const left=36, right=559, width=right-left;
  const wrap = (value, maxWidth, size=9, font=regular) => {
    const result=[];
    for (const paragraph of text(value).split('\n')) {
      let row='';
      for (const word of paragraph.split(/\s+/)) {
        if (font.widthOfTextAtSize((row ? row+' ' : '')+word,size)>maxWidth && row) {result.push(row);row='';}
        let rest=word;
        while(font.widthOfTextAtSize(rest,size)>maxWidth) {
          let cut=1;
          while(cut<rest.length && font.widthOfTextAtSize(rest.slice(0,cut+1),size)<=maxWidth) cut++;
          if(row){result.push(row);row='';}
          result.push(rest.slice(0,cut));rest=rest.slice(cut);
        }
        row+=(row?' ':'')+rest;
      }
      result.push(row);
    }
    return result;
  };
  function draw(value,x,at,size=9,font=regular,color=ink) { page.drawText(text(value),{x,y:at,size,font,color}); }
  function newPage() {
    page=doc.addPage([595.28,841.89]);y=800;
    draw(bill.issuer.name || 'JYOTI REFRIGERATION',left,y,16,bold,green);y-=19;
    draw('TAX INVOICE  |  '+bill.number,right-230,y+19,10,bold); 
    for(const row of wrap(bill.issuer.address,width,8)){draw(row,left,y,8);y-=11;}
    draw([bill.issuer.phone,bill.issuer.email].filter(Boolean).join(' | '),left,y,8);y-=15;
    page.drawLine({start:{x:left,y},end:{x:right,y},thickness:1,color:green});y-=19;
  }
  function space(h){if(y-h<48)newPage();}
  function block(label,value) {
    const rows=wrap(value,width,9);space(18+rows.length*12);draw(label,left,y,9,bold);y-=13;
    for(const row of rows){draw(row,left,y);y-=12;}y-=7;
  }
  function summary(label,value,strong=false){space(19);draw(label,left+285,y,9,strong?bold:regular);const s=money(value);draw(s,right-(strong?bold:regular).widthOfTextAtSize(s,10),y,10,strong?bold:regular);y-=17;}
  newPage();
  draw('Invoice date: '+dateLabel(bill.issued_on),left,y,9,bold);
  draw('GSTIN: '+(bill.issuer.gstin||''),left+260,y,9);y-=19;
  draw('Place of supply: Chhattisgarh (22) | Reverse charge: N',left,y,8);y-=21;
  block('Billed to / Shipped to',bill.customer_name+'\n'+bill.service_address+(bill.customer_gstin?'\nGSTIN / UIN: '+bill.customer_gstin:''));
  const xs=[left,left+25,left+255,left+305,left+347,left+382,left+451,right];
  function tableHeader(){space(40);page.drawRectangle({x:left,y:y-20,width,height:25,color:rgb(.91,.96,.94)});['#','Goods / Services','HSN/SAC','Qty','Unit','Rate','Amount'].forEach((s,i)=>draw(s,xs[i]+4,y-11,8,bold));y-=28;}
  tableHeader();
  for(const [i,l] of bill.lines.entries()) {
    const cells=[String(i+1),l.description,l.hsn_sac,l.quantity,l.uom,money(l.unit_price),money(l.base_before_discount??l.amount)];
    const rows=cells.map((v,c)=>wrap(v,xs[c+1]-xs[c]-8,8));
    const h=Math.max(...rows.map(v=>v.length))*11+10;
    if(y-h<65){newPage();tableHeader();}
    if(h>640)throw new Error('Invoice line is too long to render');
    rows.forEach((values,c)=>values.forEach((s,j)=>draw(s,xs[c]+4,y-10-j*11,8)));
    y-=h;page.drawLine({start:{x:left,y},end:{x:right,y},thickness:.4,color:line});
  }
  y-=20;
  if(Number(bill.discount_amount)>0){summary('Total before discount (incl. GST)',bill.gross_total);summary('Discount ('+money(bill.discount_percent)+'%)',-Number(bill.discount_amount));}
  summary('Taxable amount',bill.subtotal);summary('CGST',bill.cgst);summary('SGST',bill.sgst);
  if(Number(bill.rounding_adjustment))summary('Rounding adjustment',bill.rounding_adjustment);
  summary('GRAND TOTAL (INR)',bill.total,true);y-=8;
  block('Amount in words',amountWords(bill.total));
  const rates=new Map();for(const l of bill.lines){const t=rates.get(l.tax_rate)||{amount:0,cgst:0,sgst:0};for(const k of ['amount','cgst','sgst'])t[k]+=Number(l[k]||0);rates.set(l.tax_rate,t);}
  block('GST breakdown', [...rates].map(([r,t])=>r+'%: Taxable Rs. '+money(t.amount)+' | CGST Rs. '+money(t.cgst)+' | SGST Rs. '+money(t.sgst)).join('\n'));
  if(bill.issuer.bank)block('Bank details',bill.issuer.bank+'\nAccount: '+(bill.issuer.account||'')+' | IFSC: '+(bill.issuer.ifsc||''));
  block('Terms & conditions','E. & O. E. Goods once sold will not be taken back.\nInterest @ 18% p.a. will be charged if payment is not made within the stipulated time.\nSubject to Ambikapur jurisdiction only.');
  space(45);draw("Receiver's signature",left,y,8);draw('For '+bill.issuer.name,right-205,y,8,bold);y-=32;draw('Authorised Signatory',right-130,y,8);
  const pages=doc.getPages();pages.forEach((p,i)=>p.drawText('Invoice '+bill.number+' | Page '+(i+1)+' of '+pages.length,{x:left,y:24,size:8,font:regular,color:ink}));
  doc.setTitle('Invoice '+bill.number);doc.setAuthor(bill.issuer.name);doc.setSubject('Service tax invoice');
  return Buffer.from(await doc.save());
}
