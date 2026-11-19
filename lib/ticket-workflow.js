import {HttpError, read} from './db.js';

export const MEDIA_BUCKET = 'ticket-media';
export const completedStatuses = ['Repair Complete','Paid, not billed','Billed','Paid'];
const imageExtensions = {'image/jpeg':'jpg','image/png':'png','image/webp':'webp'};

export function imageMime(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && Buffer.from(bytes.subarray(0,8)).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (Buffer.from(bytes.subarray(0,4)).toString() === 'RIFF' && Buffer.from(bytes.subarray(8,12)).toString() === 'WEBP') return 'image/webp';
  return null;
}

export async function accessibleTicket(userDb, staff, id) {
  if (!['manager','billing','technician'].includes(staff.role)) throw new HttpError(403,'Staff access required');
  return read(userDb.from('service_tickets').select('*').eq('id',id).single());
}

export function canUpload(staff,ticket,stage) {
  if (staff.role !== 'manager' && !(staff.role === 'technician' && ticket.assigned_to === staff.user_id) &&
      !(staff.role === 'billing' && ['payment','signature'].includes(stage))) throw new HttpError(403,'Only the assigned technician or authorized staff can attach this image');
  if (['payment','signature'].includes(stage) && !completedStatuses.includes(ticket.status)) throw new HttpError(422,'Complete the repair before collecting payment');
}

async function signMedia(db,media) {
  if (!media.length) return [];
  const urls = await read(db.storage.from(MEDIA_BUCKET).createSignedUrls(media.map(row=>row.object_path),600));
  return media.map((row,index)=>({id:row.id,stage:row.stage,file_name:row.file_name,created_at:row.created_at,
    uploaded_by_name:row.staff?.name || 'Staff',payment_id:row.payment_id,url:urls[index]?.signedUrl || null}));
}

export async function ticketEvidence(db,id) {
  const [payments,media,parts,invoice] = await Promise.all([
    read(db.from('payments').select('id,receipt_number,amount,method,reference,paid_at,acknowledgement,signature_waiver,proof_media_id,signature_media_id,staff:collected_by(name)').eq('ticket_id',id).order('paid_at')),
    read(db.from('ticket_media').select('*,staff:uploaded_by(name)').eq('ticket_id',id).eq('ready',true).order('created_at')),
    read(db.from('ticket_parts').select('item_id,quantity,items(code,description,uom)').eq('ticket_id',id)),
    read(db.from('invoices').select('id,number,total,issued_on').eq('ticket_id',id).maybeSingle()),
  ]);
  const visibleMedia = media.filter(row=>['inspection','completion'].includes(row.stage) || row.payment_id);
  const photos = await signMedia(db,visibleMedia);
  const collected = Math.round(payments.reduce((sum,p)=>sum+Number(p.amount),0)*100)/100;
  return {payments:payments.map(({staff,...payment})=>({...payment,collected_by_name:staff?.name || 'Billing team'})),media:photos,parts,invoice,
    collected,remaining:invoice ? Math.max(0,Math.round((Number(invoice.total)-collected)*100)/100) : null,
    excess:invoice ? Math.max(0,Math.round((collected-Number(invoice.total))*100)/100) : 0};
}

export async function createMediaUpload(context,input) {
  const {db,userDb,staff} = context;
  const ticket = await accessibleTicket(userDb,staff,input.id);
  canUpload(staff,ticket,input.stage);
  const path = input.id+'/'+input.media_id+'.'+imageExtensions[input.mime_type];
  await read(db.from('ticket_media').upsert({id:input.media_id,ticket_id:input.id,stage:input.stage,
    object_path:path,mime_type:input.mime_type,file_name:input.file_name,file_size:input.file_size,uploaded_by:staff.user_id},
  {onConflict:'id',ignoreDuplicates:true}));
  const row = await read(db.from('ticket_media').select('*').eq('id',input.media_id).single());
  if (row.ticket_id !== input.id || row.uploaded_by !== staff.user_id || row.object_path !== path || row.stage !== input.stage || row.file_size !== input.file_size) throw new HttpError(409,'Upload ID already used');
  if (row.ready) return {id:row.id,ready:true};
  const signed = await read(db.storage.from(MEDIA_BUCKET).createSignedUploadUrl(path));
  return {id:row.id,signedUrl:signed.signedUrl};
}

export async function finalizeMedia(context,input) {
  const {db,userDb,staff} = context;
  const row = await read(db.from('ticket_media').select('*').eq('id',input.media_id).eq('ticket_id',input.id).single());
  const ticket = await accessibleTicket(userDb,staff,input.id);
  canUpload(staff,ticket,row.stage);
  if (row.uploaded_by !== staff.user_id) throw new HttpError(403,'Only the uploader can finish this upload');
  if (row.ready) return {id:row.id};
  const blob = await read(db.storage.from(MEDIA_BUCKET).download(row.object_path));
  if (blob.size !== row.file_size || blob.size > 6291456) throw new HttpError(422,'Image size does not match the upload');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (imageMime(bytes) !== row.mime_type) throw new HttpError(422,'Choose a JPEG, PNG or WebP image');
  await read(db.from('ticket_media').update({ready:true}).eq('id',row.id).eq('uploaded_by',staff.user_id));
  return {id:row.id};
}
