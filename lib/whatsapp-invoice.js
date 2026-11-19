import { createHmac, timingSafeEqual } from 'node:crypto';
import { invoiceFilename, money, dateLabel } from './invoice-pdf.js';

export const TEMPLATE_NAME='jyoti_service_invoice_v1';
export const TEMPLATE_BODY='Hello {{1}},\n\nYour invoice {{2}} dated {{3}} from Jyoti Refrigeration is ready.\nTotal invoice amount: Rs. {{4}}.\n\nPlease find your invoice PDF attached. For any invoice or service queries, contact us at 9340871636.';
export function validSignature(body,signature,token,now=Date.now()) {
  if(!body || !['send','setup_template','send_session_test'].includes(body.action) || !/^\d{10}$/.test(String(body.timestamp)))return false;
  if(body.action!=='setup_template' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.invoice_id||''))return false;
  if(Math.abs(now/1000-Number(body.timestamp))>300 || !/^[a-f0-9]{64}$/i.test(signature||''))return false;
  const expected=createHmac('sha256',token).update(body.action+':'+(body.invoice_id||'')+':'+body.timestamp).digest();
  return timingSafeEqual(expected,Buffer.from(signature,'hex'));
}
export function sessionDocumentPayload(bill,mediaId,recipient) {
  if(recipient!=='919685858101')throw new Error('Test recipient restriction');
  const caption=TEMPLATE_BODY.replace('{{1}}',String(bill.customer_name)).replace('{{2}}',String(bill.number)).replace('{{3}}',dateLabel(bill.issued_on)).replace('{{4}}',money(bill.total));
  return {messaging_product:'whatsapp',to:recipient,type:'document',document:{id:mediaId,filename:invoiceFilename(bill),caption}};
}
export function templateDefinition(handle) {return {name:TEMPLATE_NAME,language:'en_US',category:'UTILITY',components:[
  {type:'HEADER',format:'DOCUMENT',example:{header_handle:[handle]}},
  {type:'BODY',text:TEMPLATE_BODY,example:{body_text:[['Customer','5001/2026-27','19-11-2026','1,500.00']]}},
  {type:'FOOTER',text:'Jyoti Refrigeration | Ambikapur'}
]};}
export function messagePayload(bill,mediaId,recipient) {
  if(recipient!=='919685858101')throw new Error('Test recipient restriction');
  return {messaging_product:'whatsapp',to:recipient,type:'template',template:{name:TEMPLATE_NAME,language:{code:'en_US'},components:[
    {type:'header',parameters:[{type:'document',document:{id:mediaId,filename:invoiceFilename(bill)}}]},
    {type:'body',parameters:[bill.customer_name,bill.number,dateLabel(bill.issued_on),money(bill.total)].map(t=>({type:'text',text:String(t)}))}
  ]}};
}
export async function metaRequest(path,token,init={}) {
  const res=await fetch('https://graph.facebook.com/v25.0/'+path,{...init,headers:{Authorization:'Bearer '+token,...init.headers},signal:AbortSignal.timeout(20000)});
  const data=await res.json();
  if(!res.ok || data.error) {const e=new Error('Meta request failed');e.code=String(data.error?.code||res.status);e.metaMessage=String(data.error?.message||'Meta request failed').replace(/EAA[A-Za-z0-9_-]+/g,'[REDACTED]').slice(0,500);throw e;}
  return data;
}

