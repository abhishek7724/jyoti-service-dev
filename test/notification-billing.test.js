import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { forms } from '../lib/validation.js';

const worker = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
async function tap(clients, ticketNumber = 10002) {
  const handlers = {};
  let pending;
  const self = { location:{origin:'https://jyoti.example'},clients,
    addEventListener:(name,handler)=>{ handlers[name] = handler; } };
  vm.runInNewContext(worker,{self,URL});
  handlers.notificationclick({
    notification:{data:{ticketNumber},close(){}},
    waitUntil:promise=>{pending = promise;},
  });
  await pending;
}

test('assignment opens the exact ticket in a new app window', async () => {
  let opened;
  await tap({matchAll:async()=>[],openWindow:async url=>{opened=url;}});
  assert.equal(opened,'https://jyoti.example/staff?ticket=10002');
});

test('assignment focuses and navigates an existing uncontrolled app window', async () => {
  let navigated;
  const client = {url:'https://jyoti.example/staff',focus:async()=>client,
    navigate:async url=>{navigated=url;return client;}};
  await tap({matchAll:async options=>{
    assert.equal(options.includeUncontrolled,true);
    return [client];
  },openWindow:()=>{throw Error('Unexpected new window');}});
  assert.equal(navigated,'https://jyoti.example/staff?ticket=10002');
});

test('assignment falls back when the existing app window disappears', async () => {
  let opened;
  await tap({matchAll:async()=>[{
    url:'https://jyoti.example/staff',
    focus:async()=>{throw Error('Window closed');},
  }],openWindow:async url=>{opened=url;}});
  assert.equal(opened,'https://jyoti.example/staff?ticket=10002');
});

test('invoice prices and discounts reject invalid input', () => {
  const invoice = {id:'00000000-0000-4000-8000-000000000001',fee:500,tax_rate:18,gstin:'',
    prices:[{item_id:'00000000-0000-4000-8000-000000000002',price:1500}],
    discount_type:'fixed',discount_value:250};
  assert.equal(forms.invoice.parse(invoice).prices[0].price,1500);
  assert.equal(forms.invoice.safeParse({...invoice,discount_value:-1}).success,false);
  assert.equal(forms.invoice.safeParse({...invoice,prices:[{...invoice.prices[0],price:-1}]}).success,false);
});

test('live invoice preview calculates percentage and fixed discounts', () => {
  const staff = readFileSync(new URL('../public/staff.js',import.meta.url),'utf8');
  const source = staff.slice(staff.indexOf('function updateInvoiceDraft'),staff.indexOf('function renderBilling'));
  const context = {money:n=>n.toFixed(2)};
  vm.createContext(context);
  vm.runInContext(source,context);
  const fields = {
    discount_type:{value:'percent'},
    discount_value:{value:'5',validity:{valid:true}},
    fee:{value:'500'},tax_rate:{value:'0'},
    'price-part':{value:'1500'},
  };
  const summary={innerHTML:''};
  const form={elements:fields,querySelector:()=>summary};
  context.updateInvoiceDraft(form,[{item_id:'part',quantity:1,items:{tax_rate:0}}]);
  assert.match(summary.innerHTML,/5.00%.*100.00/);
  assert.match(summary.innerHTML,/Amount payable 1900.00/);
  fields.discount_type.value='fixed';
  fields.discount_value.value='250';
  context.updateInvoiceDraft(form,[{item_id:'part',quantity:1,items:{tax_rate:0}}]);
  assert.match(summary.innerHTML,/12.50%.*250.00/);
  assert.match(summary.innerHTML,/Amount payable 1750.00/);
});
