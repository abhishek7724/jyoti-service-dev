import { clients, read } from '../lib/db.js';
import { invoicePdf, invoiceFilename } from '../lib/invoice-pdf.js';
import { TEMPLATE_NAME, validSignature, templateDefinition, messagePayload, sessionDocumentPayload, metaRequest } from '../lib/whatsapp-invoice.js';

const sample={number:'SAMPLE-5001',issued_on:'2026-11-19',customer_name:'Sample Customer',service_address:'Sample address, Ambikapur, Chhattisgarh',customer_gstin:'',
  issuer:{name:'JYOTI REFRIGERATION.',address:'Ambikapur, Chhattisgarh',phone:'9340871636'},
  lines:[{description:'Appliance service',hsn_sac:'9987',quantity:1,uom:'Pcs.',unit_price:1500,amount:1500,tax_rate:0,cgst:0,sgst:0}],subtotal:1500,cgst:0,sgst:0,total:1500};

export default async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='POST')return res.status(405).json({error:'POST required'});
  let body=req.body;
  if(typeof body==='string'){try{body=JSON.parse(body);}catch{return res.status(400).json({error:'Invalid request'});}}
  // Reject malformed signatures before looking up any secrets or invoice records.
  if(!/^[a-f0-9]{64}$/i.test(req.headers['x-jyoti-signature']||''))return res.status(401).json({error:'Unauthorized'});
  let db,config,claimed=false,phase='prepare';
  try {
    ({db}=clients());
    config=await read(db.rpc('jyoti_whatsapp_config'));
    if(!config?.token || !validSignature(body,req.headers['x-jyoti-signature'],config.token))return res.status(401).json({error:'Unauthorized'});
    if(!config.enabled)return res.status(409).json({error:'WhatsApp testing disabled'});
    const sessionTest=body.action==='send_session_test';
    if(sessionTest && Date.now()>=Date.parse('2026-11-20T00:00:00Z'))return res.status(410).json({error:'Temporary session test expired'});
    const token=config.token,account='1418702660344841',phone='1403299919539677';
    const templates=await metaRequest(account+'/message_templates?name='+TEMPLATE_NAME+'&fields=name,status,components',token);
    let template=templates.data?.find(t=>t.name===TEMPLATE_NAME);
    if(body.action==='setup_template') {
      if(template)return res.status(200).json({template:TEMPLATE_NAME,status:template.status});
      const pdf=await invoicePdf(sample);
      const params=new URLSearchParams({file_name:'Jyoti-Sample-Invoice.pdf',file_length:String(pdf.length),file_type:'application/pdf'});
      const upload=await metaRequest('897684976718191/uploads?'+params,token,{method:'POST'});
      if(typeof upload.id!=='string'||!upload.id.startsWith('upload:'))throw new Error('No sample upload session');
      const handle=await metaRequest(upload.id,token,{method:'POST',headers:{Authorization:'OAuth '+token,file_offset:'0','Content-Type':'application/pdf'},body:pdf});
      if(!handle.h)throw new Error('No sample document handle');
      template=await metaRequest(account+'/message_templates',token,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(templateDefinition(handle.h))});
      return res.status(200).json({template:TEMPLATE_NAME,status:template.status,id:template.id});
    }
    if(!sessionTest && template?.status!=='APPROVED') {
      await read(db.rpc('jyoti_whatsapp_wait_for_template',{p_invoice:body.invoice_id}));
      return res.status(202).json({state:'waiting_template',template_status:template?.status||'MISSING'});
    }
    const bill=await read(db.rpc('jyoti_whatsapp_claim',{p_invoice:body.invoice_id}));
    if(!bill)return res.status(200).json({state:'already_processed'});
    claimed=true;
    const pdf=await invoicePdf(bill);
    // Keep the PDF private; it is uploaded directly to Meta, never exposed by a public URL.
    const buckets=await read(db.storage.listBuckets());
    if(!buckets.some(b=>b.id==='invoice-pdfs'))await read(db.storage.createBucket('invoice-pdfs',{public:false,fileSizeLimit:10485760,allowedMimeTypes:['application/pdf']}));
    await read(db.storage.from('invoice-pdfs').upload(bill.id+'.pdf',pdf,{contentType:'application/pdf',upsert:true}));
    const form=new FormData();form.set('messaging_product','whatsapp');form.set('type','application/pdf');
    form.set('file',new Blob([pdf],{type:'application/pdf'}),invoiceFilename(bill));
    const media=await metaRequest(phone+'/media',token,{method:'POST',body:form});
    if(!media.id)throw new Error('No uploaded PDF media ID');
    phase='send';
    const result=await metaRequest(phone+'/messages',token,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(sessionTest?sessionDocumentPayload(bill,media.id,config.test_recipient):messagePayload(bill,media.id,config.test_recipient))});
    const message=result.messages?.[0];
    if(!message?.id)throw new Error('No message acceptance returned');
    phase='accepted';
    await read(db.rpc('jyoti_whatsapp_finish',{p_invoice:bill.id,p_state:'accepted',p_message:message.id,p_media:media.id,p_error:null}));
    return res.status(200).json({state:'accepted',invoice_number:bill.number,message_id:message.id});
  }catch(error) {
    // Never retry an ambiguous send automatically: Meta may have accepted it already.
    const state=phase==='send'||phase==='accepted'?'unknown':'failed';
    if(claimed&&db){try{await read(db.rpc('jyoti_whatsapp_finish',{p_invoice:body.invoice_id,p_state:state,p_message:null,p_media:null,p_error:String(error.code||'INTERNAL')}));}catch{}}
    console.error('Invoice WhatsApp operation failed',{phase,code:error.code||'INTERNAL'});
    return res.status(502).json({state,code:error.code||'INTERNAL',error:error.metaMessage||'Invoice WhatsApp operation failed'});
  }
}

