const escape = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const rupees = value => new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR'}).format(Number(value));
const when = value => new Date(value).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kolkata'});

export function statusBadge(status) {
  const style = status === 'Paid, not billed' ? ' status-unbilled' : ['Awaiting Parts','Assignment Rejected'].includes(status) ? ' status-awaiting' : '';
  return '<span class="badge'+style+'">'+escape(status === 'Assignment Rejected' ? 'Assigned technician rejected' : status)+'</span>';
}

export function photoGallery(media,stage) {
  const photos = media.filter(photo=>photo.stage === stage);
  if (!photos.length) return '<p class="meta">No photos attached.</p>';
  return '<div class="photo-gallery">'+photos.map(photo=>'<figure>'+
    (photo.url ? '<a href="'+escape(photo.url)+'" target="_blank" rel="noopener noreferrer"><img loading="lazy" src="'+escape(photo.url)+'" alt="'+escape(stage)+' photo"></a>' : '<span>Image unavailable</span>')+
    '<figcaption>'+escape(photo.uploaded_by_name)+' · '+escape(when(photo.created_at))+'</figcaption></figure>').join('')+'</div>';
}

export function receiptHistory(payments,media) {
  if (!payments.length) return '<p class="meta">No payments received.</p>';
  return payments.map(payment=>{
    const evidence = media.filter(photo=>photo.id === payment.proof_media_id || photo.id === payment.signature_media_id);
    return '<details class="receipt"><summary><strong>RCPT-'+escape(payment.receipt_number)+'</strong> · '+rupees(payment.amount)+' · '+escape(payment.method)+'</summary>'+
      '<p class="meta">Received '+escape(when(payment.paid_at))+' · '+escape(payment.collected_by_name)+'</p>'+
      (payment.reference ? '<p>Transaction reference · '+escape(payment.reference)+'</p>' : '')+
      (payment.acknowledgement ? '<p>'+escape(payment.acknowledgement)+'</p>' : '')+
      (payment.signature_waiver ? '<p>Customer could not sign · '+escape(payment.signature_waiver)+'</p>' : '')+
      evidence.map(photo=>photo.url ? '<figure class="payment-proof"><figcaption>'+ (photo.stage === 'signature' ? 'Customer signature' : 'Payment proof')+'</figcaption><a href="'+escape(photo.url)+'" target="_blank" rel="noopener noreferrer"><img loading="lazy" src="'+escape(photo.url)+'" alt="'+(photo.stage === 'signature' ? 'Customer signature' : 'Payment proof')+'"></a></figure>' : '<p class="meta">Image unavailable.</p>').join('')+'</details>';
  }).join('');
}

export function financialSummary(data) {
  return '<dl class="financial-summary">'+(data.invoice ? '<div><dt>Invoice '+escape(data.invoice.number)+'</dt><dd>'+rupees(data.invoice.total)+'</dd></div>' : '<div><dt>Invoice</dt><dd>Not issued</dd></div>')+
    '<div><dt>Amount received</dt><dd>'+rupees(data.collected)+'</dd></div>'+
    (data.invoice ? '<div><dt>Remaining amount</dt><dd>'+rupees(data.remaining)+'</dd></div>' : '')+
    (data.excess > 0 ? '<div class="excess-payment"><dt>Excess collected · refund or credit required</dt><dd>'+rupees(data.excess)+'</dd></div>' : '')+'</dl>';
}
