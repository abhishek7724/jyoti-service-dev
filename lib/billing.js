import {HttpError} from './db.js';

export function billingQuery(input){
 const {tab='invoices',status='all',search='',limit=25,offset=0,from='',to=''}=input;
 if(!['invoices','ready'].includes(tab)||!['all','pending','part_paid','paid','excess'].includes(status)||
  ![10,25,50].includes(limit)||!Number.isSafeInteger(offset)||offset<0||offset>10000000||typeof search!=='string'||search.length>100){
  throw new HttpError(422,'Choose valid billing filters');
 }
 const validDate=value=>value===''||(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&
  Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value);
 if(!validDate(from)||!validDate(to)||(from&&to&&from>to))throw new HttpError(422,'Choose a valid date range');
 return {p_tab:tab,p_status:status,p_search:search.trim(),p_limit:limit,p_offset:offset,p_from:from||null,p_to:to||null};
}
