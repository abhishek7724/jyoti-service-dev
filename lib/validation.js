import { z } from 'zod';

const text = (max) => z.string().trim().min(1).max(max);
const optionalText = (max) => z.string().trim().max(max).default('');
export const uuid = z.uuid();
export const mobile = z.string().regex(/^[6-9][0-9]{9}$/, 'Enter a valid 10-digit Indian mobile number');
export const serviceTypes = ['Bring to Shop', 'Home Visit', 'Home Pickup', 'Installation', 'Preventive Maintenance', 'Warranty Service'];
export const roles = ['manager', 'technician', 'billing'];
const amount = z.number().min(0).max(9999999).multipleOf(0.01);
const quantity = z.number().positive().max(999999).multipleOf(0.001);

export const ticket = z.object({
  customer_name: text(100),
  mobile,
  locality: text(100),
  city: text(100).default('Ambikapur, CG'),
  service_address: text(500),
  appliance: text(100),
  brand: text(100),
  service_type: z.enum(serviceTypes),
  issue: text(2000),
  maps_url: z.string().max(750).nullable().default(null),
  latitude: z.number().min(-90).max(90).nullable().default(null),
  longitude: z.number().min(-180).max(180).nullable().default(null),
}).superRefine((data, ctx) => {
  if ((data.latitude === null) !== (data.longitude === null)) {
    ctx.addIssue({ code: 'custom', message: 'Add a location pin for the home visit' });
  }
});

export const forms = {
  staff: z.object({ name: text(100), username: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._-]{2,31}$/), password: z.string().min(10).max(72), role: z.enum(['technician','billing']) }),
  assign: z.object({ id: uuid, technician_id: uuid.nullable() }),
  status: z.object({ id: uuid, status: z.enum(['In Progress','Awaiting Parts','Repair Complete']) }),
  parts: z.object({ id: uuid, parts: z.array(z.object({ item_id: uuid, quantity })).min(1, 'Add at least one item in Parts used').max(40) }),
  item: z.object({ code: text(32), description: text(180), uom: text(20), hsn_sac: optionalText(12), purchase_price: amount, sale_price: amount, tax_rate: amount.max(100) }),
  supplier: z.object({ name: text(150), contact: optionalText(100), address: optionalText(300), gstin: optionalText(15) }),
  po: z.object({ supplier_id: uuid, ticket_id: uuid.nullable(), lines: z.array(z.object({ item_id: uuid, quantity, unit_price: amount })).min(1).max(40) }),
  receipt: z.object({ id: uuid, line_id: uuid, quantity }),
  supplierBill: z.object({ po_id: uuid, bill_number: text(60), bill_date: z.iso.date(), amount: amount.positive() }),
  invoice: z.object({ id: uuid, fee: amount, tax_rate: amount.max(100), gstin: optionalText(15) }),
  payment: z.object({ id: uuid, invoice_id: uuid.nullable().default(null), supplier_bill_id: uuid.nullable().default(null), amount: amount.positive(), method: z.enum(['Cash','UPI','Bank Transfer','Card','Other']), reference: optionalText(100) }),
  subscription: z.object({ endpoint: z.url(), keys: z.object({ auth: text(120), p256dh: text(150) }) }),
};

export function staffEmail(username) {
  const value = username.trim().toLowerCase();
  return value.includes('@') ? value : value + '@staff.jyoti.invalid';
}

export function validatePushEndpoint(endpoint) {
  const url = new URL(endpoint);
  const supported = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'];
  return url.protocol === 'https:' && !url.port && !url.username && !url.password &&
    (supported.includes(url.hostname) || url.hostname.endsWith('.notify.windows.com'));
}
