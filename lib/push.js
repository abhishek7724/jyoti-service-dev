import {sendNotification} from 'web-push';
import {read} from './db.js';
import {validatePushEndpoint} from './validation.js';

export async function sendAssignmentAlerts(db,assignee,ticketNumber,{send=sendNotification,env=process.env,now=()=>new Date().toISOString()}={}){
 const {WEB_PUSH_PUBLIC_KEY:publicKey,WEB_PUSH_PRIVATE_KEY:privateKey,WEB_PUSH_SUBJECT:subject}=env;
 if(!publicKey || !privateKey || !subject)return 'Push is not configured';
 const subscriptions=await read(db.from('push_subscriptions').select('endpoint,subscription').eq('user_id',assignee));
 if(!subscriptions.length)return 'Technician has no notification subscription';
 let accepted=0;
 const payload=JSON.stringify({title:'Ticket #'+ticketNumber+' assigned',body:'Ticket #'+ticketNumber+' has been assigned to you. Tap to accept or reject.',ticketNumber});
 const options={vapidDetails:{subject,publicKey,privateKey},timeout:3500,TTL:86400,urgency:'high',topic:'jyoti-ticket-'+ticketNumber};
 await Promise.all(subscriptions.map(async({endpoint,subscription})=>{
  if(!validatePushEndpoint(endpoint))return;
  for(let attempt=0;attempt<2;attempt++){
   try{
    await send(subscription,payload,options);accepted++;
    await db.from('push_subscriptions').update({last_accepted_at:now(),last_error_code:null}).eq('endpoint',endpoint).eq('user_id',assignee);
    return;
   }catch(error){
    const code=Number(error.statusCode) || 0;
    if([404,410].includes(code)){
     await db.from('push_subscriptions').delete().eq('endpoint',endpoint).eq('user_id',assignee);return;
    }
    if(attempt===0 && (code===0 || code===429 || code>=500))continue;
    await db.from('push_subscriptions').update({last_error_code:code}).eq('endpoint',endpoint).eq('user_id',assignee);
    console.warn('Assignment push not accepted',{ticketNumber,status:code});return;
   }
  }
 }));
 return accepted ? 'Push accepted by notification service ('+accepted+' device'+(accepted===1?'':'s')+')' : 'Push could not be delivered';
}
