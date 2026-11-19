import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {PDFDocument} from 'pdf-lib';
import {invoicePdf} from '../lib/invoice-pdf.js';
import {validSignature,messagePayload,templateDefinition,TEMPLATE_NAME} from '../lib/whatsapp-invoice.js';
import handler from '../api/whatsapp-invoice.js';

const bill={id:'aaaaaaaa-0000-4000-8000-000000000001',number:'5001/2026-27',issued_on:'2026-11-19',customer_name:'Example Customer',service_address:'Ambikapur, Chhattisgarh',customer_gstin:'',
 issuer:{name:'JYOTI REFRIGERATION.',address:'Ambikapur, Chhattisgarh',phone:'9340871636'},
 lines:[{description:'Service',hsn_sac:'9987',quantity:1,uom:'Pcs.',unit_price:1000,amount:1000,cgst:90,sgst:90,tax_rate:18}],subtotal:1000,cgst:90,sgst:90,total:1180};
test('callback rejects tampering, stale requests and invalid invoice IDs',()=>{
 const body={action:'send',invoice_id:bill.id,timestamp:'1795060000'},token='test-only-secret';
 const signature=createHmac('sha256',token).update('send:'+bill.id+':'+body.timestamp).digest('hex');
 assert.equal(validSignature(body,signature,token,1795060000000),true);
 assert.equal(validSignature({...body,invoice_id:'bbbbbbbb-0000-4000-8000-000000000001'},signature,token,1795060000000),false);
 assert.equal(validSignature(body,signature,token,1795060600000),false);
 assert.equal(validSignature({...body,invoice_id:'no'},signature,token,1795060000000),false);
});
test('invoice template has a document header and four matching body variables',()=>{
 const definition=templateDefinition('sample-handle'),message=messagePayload(bill,'media-id','919685858101');
 assert.equal(definition.category,'UTILITY');assert.equal(definition.components[0].format,'DOCUMENT');
 assert.equal(message.template.name,TEMPLATE_NAME);
 assert.equal(message.template.components[0].parameters[0].document.filename,'Jyoti-Invoice-5001-2026-27.pdf');
 assert.deepEqual(message.template.components[1].parameters.map(p=>p.text),['Example Customer','5001/2026-27','19-11-2026','1,180.00']);
 assert.throws(()=>messagePayload(bill,'media','919999999999'),/restriction/);
});
test('server invoice is a valid PDF and paginates large invoices',async()=>{
 const single=await invoicePdf(bill);assert.equal(single.subarray(0,5).toString(),'%PDF-');
 assert.equal((await PDFDocument.load(single)).getPageCount(),1);
 const large=await invoicePdf({...bill,lines:Array.from({length:85},(_,i)=>({...bill.lines[0],description:'Replacement part '+i+' with a detailed service description'}))});
 assert.ok((await PDFDocument.load(large)).getPageCount()>2);
});
test('public callback rejects unsigned calls before any database lookup',async()=>{
 const res={setHeader(){},status(n){this.code=n;return this;},json(v){this.body=v;}};
 await handler({method:'POST',headers:{},body:{action:'send',invoice_id:bill.id}},res);
 assert.equal(res.code,401);
});

test('approved template uploads a private invoice PDF and sends its exact media ID',async()=>{
 const realFetch=globalThis.fetch,token='test-only-secret';let sent,uploaded=false,finished=false;
 Object.assign(process.env,{SUPABASE_URL:'https://db.example.invalid',SUPABASE_PUBLISHABLE_KEY:'test-only',SUPABASE_SERVICE_ROLE_KEY:'test-only'});
 const body={action:'send',invoice_id:bill.id,timestamp:String(Math.floor(Date.now()/1000))};
 const signature=createHmac('sha256',token).update('send:'+bill.id+':'+body.timestamp).digest('hex');
 globalThis.fetch=async(url,init)=>{
   const u=new URL(url),path=u.pathname;
   if(path.endsWith('/jyoti_whatsapp_config'))return Response.json({token,enabled:true,test_recipient:'919685858101'});
   if(path.endsWith('/message_templates'))return Response.json({data:[{name:TEMPLATE_NAME,status:'APPROVED'}]});
   if(path.endsWith('/jyoti_whatsapp_claim'))return Response.json(bill);
   if(path==='/storage/v1/bucket')return Response.json([{id:'invoice-pdfs',public:false}]);
   if(path.includes('/storage/v1/object/invoice-pdfs/')){assert.equal(Buffer.from(init.body).subarray(0,5).toString(),'%PDF-');uploaded=true;return Response.json({Key:'invoice.pdf'});}
   if(path.endsWith('/media')){assert.ok(uploaded);assert.equal(init.body.get('file').type,'application/pdf');return Response.json({id:'media-test'});}
   if(path.endsWith('/messages')){sent=JSON.parse(init.body);return Response.json({messages:[{id:'message-test',message_status:'accepted'}]});}
   if(path.endsWith('/jyoti_whatsapp_finish')){const b=JSON.parse(init.body);assert.equal(b.p_state,'accepted');assert.equal(b.p_media,'media-test');finished=true;return Response.json(null);}
   throw new Error('Unexpected fetch '+path);
 };
 try{
  const res={setHeader(){},status(n){this.code=n;return this;},json(v){this.body=v;}};
  await handler({method:'POST',headers:{'x-jyoti-signature':signature},body},res);
  assert.equal(res.code,200);assert.equal(finished,true);assert.equal(sent.template.components[0].parameters[0].document.id,'media-test');
 }finally{globalThis.fetch=realFetch;}
});
