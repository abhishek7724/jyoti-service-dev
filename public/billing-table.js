const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=value=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR'}).format(Number(value||0));
const paths={view:'<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
 print:'<path d="M6 9V3h12v6M6 17H3V9h18v8h-3M6 14h12v7H6z"/>',
 edit:'<path d="m16 3 5 5-12 12H4v-5ZM14 5l5 5"/>',
 pay:'<path d="M20 8V5H4a2 2 0 0 0 0 4h17v12H4a2 2 0 0 1-2-2V7M16 13v4M14 15h4"/>',
 call:'<path d="M22 16.9v3a2 2 0 0 1-2.2 2A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3l2 5-2 2a16 16 0 0 0 8 8l2-2Z"/>',
 refresh:'<path d="M21 4v6h-6M3 20v-6h6M5.5 7A8 8 0 0 1 19 5l2 5M3 14l2 5a8 8 0 0 0 13.5-2"/>'};
export const billingIcon=name=>'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+paths[name]+'</svg>';
const action=(name,id,label,disabled=false)=>'<button type="button" class="secondary billing-icon" data-invoice-'+name+'="'+escape(id)+'" title="'+escape(label)+'" aria-label="'+escape(label)+'"'+(disabled?' disabled':'')+'>'+billingIcon(name)+'</button>';
const choices=(values,selected)=>values.map(([value,label])=>'<option value="'+value+'"'+(String(value)===String(selected)?' selected':'')+'>'+label+'</option>').join('');
export function billingMarkup(data,state){
 const {summary={},counts={},invoices=[],completed=[],total=0,offset=0,limit=25}=data;
 const ready=state.tab==='ready';
 const row=b=>{
  const paid=b.payment_status==='paid',status=b.payment_status==='pending'?'Pending payment':paid?'Paid':'Part paid';
  const due=Number(b.due),received=Number(b.received),excess=Number(b.excess);
  const editAllowed=received===0||received<Number(b.total);
  const call=b.service_tickets?.mobile;
  return '<tr><td><strong>'+escape(b.number)+'</strong><span class="billing-sub">Ticket #'+escape(b.service_tickets?.ticket_number)+'</span></td><td>'+escape(b.customer_name)+'</td>'+[b.total,received,due].map(n=>'<td class="billing-money">'+money(n)+'</td>').join('')+
   '<td><span class="badge billing-status billing-'+escape(b.payment_status)+'">'+status+'</span>'+(excess>0?'<span class="billing-excess">'+money(excess)+' excess</span>':'')+'</td>'+
   '<td><div class="billing-actions">'+action('view',b.id,'View invoice '+b.number)+action('print',b.id,'Print / PDF '+b.number)+action('edit',b.id,editAllowed?'Edit invoice '+b.number:'Fully paid invoice is locked',!editAllowed)+action('pay',b.id,due>0?'Receive payment for '+b.number:'No amount due',due<=0)+
   (call?'<a class="secondary billing-icon" href="tel:+91'+escape(call)+'" title="Call customer" aria-label="Call '+escape(b.customer_name)+'">'+billingIcon('call')+'</a>':'<button class="secondary billing-icon" disabled aria-label="No customer phone number">'+billingIcon('call')+'</button>')+'</div></td></tr>';
 };
 const readyRow=t=>'<tr><td><strong>#'+escape(t.ticket_number)+'</strong></td><td>'+escape(t.customer_name)+'</td><td>'+escape(t.appliance)+'</td><td class="billing-money">'+money(t.received)+'</td><td><span class="badge '+(Number(t.received)>0?'status-unbilled':'')+'">'+(Number(t.received)>0?'Paid, not billed':'Ready to bill')+'</span></td><td><button type="button" data-draft="'+escape(t.id)+'">Review invoice</button></td></tr>';
 const count=ready?completed.length:invoices.length;
 return '<div class="billing-workspace"><p class="muted billing-subtitle">Invoices and customer payments</p><div class="billing-summary">'+
 [['To collect',money(summary.due)],['Pending payment',summary.pending||0],['Part paid',summary.part_paid||0],['Excess received',money(summary.excess)]].map(([label,value])=>'<div class="panel billing-stat"><span>'+label+'</span><strong>'+value+'</strong></div>').join('')+'</div>'+
 '<div class="billing-tabs" role="tablist" aria-label="Billing lists">'+[['ready','Ready to bill',counts.ready||0],['invoices','Issued invoices',counts.invoices||0]].map(([tab,label,n])=>'<button type="button" role="tab" aria-selected="'+(state.tab===tab)+'" data-billing-tab="'+tab+'">'+label+' <span>'+n+'</span></button>').join('')+'</div>'+
 '<section class="panel billing-panel"><form id="billing-filters" class="billing-toolbar"><label class="billing-search">Search<input name="search" maxlength="100" placeholder="Invoice, ticket or customer" value="'+escape(state.search)+'"></label>'+
 (ready?'':'<label>Payment status<select name="status">'+choices([['all','All statuses'],['pending','Pending payment'],['part_paid','Part paid'],['paid','Paid'],['excess','Excess received']],state.status)+'</select></label>')+
 '<label>From date<input type="date" name="from" value="'+escape(state.from)+'"></label><label>To date<input type="date" name="to" value="'+escape(state.to)+'"></label><button type="submit">Search</button><button type="button" id="billing-refresh" class="secondary billing-icon" title="Refresh billing" aria-label="Refresh billing">'+billingIcon('refresh')+'</button></form>'+
 '<div class="table-wrap billing-table-wrap" role="region" aria-label="'+(ready?'Ready to bill':'Issued invoices')+'" tabindex="0"><table class="billing-table"><thead><tr>'+(ready?['Ticket','Customer','Appliance','Received','Status','Actions']:['Invoice / Ticket','Customer','Total','Received','Due','Payment status','Actions']).map((label,i)=>'<th scope="col"'+((!ready&&i>=2&&i<=4)||(ready&&i===3)?' class="billing-money"':'')+'>'+label+'</th>').join('')+'</tr></thead><tbody>'+
 (count?(ready?completed.map(readyRow):invoices.map(row)).join(''):'<tr><td colspan="'+(ready?6:7)+'" class="billing-empty">'+(state.search||(!ready&&state.status!=='all')||state.from||state.to?'No results match your filters.':ready?'No completed repairs awaiting billing.':'No invoices issued yet.')+'</td></tr>')+'</tbody></table></div>'+
 '<div class="billing-pagination"><span role="status">Showing '+(total?offset+1:0)+'–'+Math.min(total,offset+count)+' of '+total+' '+(ready?'tickets':'invoices')+'</span><div><label>Rows per page<select id="billing-page-size">'+choices([[10,'10'],[25,'25'],[50,'50']],limit)+'</select></label><button type="button" class="secondary" id="billing-prev"'+(offset===0?' disabled':'')+'>Previous</button><span class="billing-page">'+(Math.floor(offset/limit)+1)+'</span><button type="button" class="secondary" id="billing-next"'+(offset+limit>=total?' disabled':'')+'>Next</button></div></div></section></div>';
}
