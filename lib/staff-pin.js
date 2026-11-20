import {createHmac} from 'node:crypto';
import {HttpError} from './db.js';

export function pinPassword(email, pin) {
  if (typeof pin !== 'string' || !/^[0-9]{4}$/.test(pin)) throw new HttpError(422,'Enter a four-digit PIN');
  const secret = process.env.STAFF_PIN_SECRET;
  if (!secret || secret.length < 32) throw new HttpError(503,'Staff sign-in is being configured');
  return createHmac('sha256',secret).update('jyoti:staff-pin:v1:' + email.trim().toLowerCase() + ':' + pin).digest('hex') + 'aA1!';
}
