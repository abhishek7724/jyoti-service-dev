import { createClient } from '@supabase/supabase-js';

const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function clients(token) {
  const { SUPABASE_URL: url, SUPABASE_PUBLISHABLE_KEY: key, SUPABASE_SERVICE_ROLE_KEY: secret } = process.env;
  if (!url || !key || !secret) throw new HttpError(503, 'The service database is being configured');
  const db = createClient(url, secret, options);
  const userDb = createClient(url, key, {
    ...options, global: token ? { headers: { Authorization: 'Bearer ' + token } } : {},
  });
  return { db, userDb };
}

export async function read(query) {
  const { data, error } = await query;
  if (!error) return data;
  if (error.code === '23505') throw new HttpError(409, 'This record already exists');
  if (error.code === 'P0001') throw new HttpError(422, error.message);
  if (error.code === 'P0002' || error.code === 'PGRST116') throw new HttpError(404, 'Record not found');
  if (['23503','23514','22P02','42501','22003'].includes(error.code)) {
    throw new HttpError(422, 'This change could not be saved. Check the fields and current status.');
  }
  console.error('Database operation failed', error.code);
  throw new HttpError(503, 'The database is temporarily unavailable');
}

export async function staffSession(req) {
  const token = /^Bearer (\S+)$/i.exec(req.headers.authorization || '')?.[1];
  if (!token) throw new HttpError(401, 'Sign in to continue');
  const { db, userDb } = clients(token);
  const { data, error } = await userDb.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, 'Your session expired. Sign in again.');
  const staff = await read(db.from('staff').select('user_id,name,role').eq('user_id', data.user.id).eq('active', true).maybeSingle());
  if (!staff) throw new HttpError(403, 'This account has no active staff access');
  return { db, userDb, staff };
}

export function requireRole(staff, ...roles) {
  if (!roles.includes(staff.role)) throw new HttpError(403, 'You do not have access to this action');
}
