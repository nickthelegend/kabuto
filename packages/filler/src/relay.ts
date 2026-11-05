/** Untrusted, self-authenticating intent bulletin board. Anyone may run a relay. */
import { createServer, type ServerResponse } from 'node:http';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type Hex } from 'viem';
import { createKabuto, explainRejection, type SignedIntent } from '@kabuto/sdk';
import { validate, decodeIntent } from './validation.js';
import { ARKIV_QUERY, arkivWriter, publishIntent, publishFill, markIntent, writerBalance } from './arkiv.js';

const sdk=createKabuto();
const dataFile=fileURLToPath(new URL('../data/intents.jsonl',import.meta.url));
mkdirSync(fileURLToPath(new URL('../data/',import.meta.url)),{recursive:true});
type Event={type:string;intentId?:string;hash?:Hex;reason?:string;time:number;[key:string]:unknown};
const clients=new Set<ServerResponse>();
const intents=new Map<string,SignedIntent>();
const pending=new Map<string,Set<string>>();
const arkivKeys=new Map<string,Hex>();
const arkivPublishing=new Map<string,Promise<void>>();
let arkivPublished=0;
let arkivLastError:string|null=null;
function noteOutcome(x:any){if(!x.intentId||!x.hash)return;const set=pending.get(x.intentId)??new Set<string>();if(x.type==='fill_submitted')set.add(String(x.hash).toLowerCase());if(['fill_landed','fill_refused','fill_replaced'].includes(x.type))set.delete(String(x.hash).toLowerCase());pending.set(x.intentId,set);}
if(existsSync(dataFile)) for(const line of readFileSync(dataFile,'utf8').split('\n')) if(line.trim()) {
  try {const x=JSON.parse(line);if(x.type==='intent_posted') intents.set(x.intentId,decodeIntent(x.signedIntent));if(x.type==='arkiv_published'&&x.intentId&&x.arkivKey){arkivKeys.set(x.intentId,x.arkivKey);arkivPublished++;}noteOutcome(x);} catch(e){console.error('Invalid persisted relay line:',e);}
}
function json(value:unknown){return JSON.stringify(value,(_k,v)=>typeof v==='bigint'?v.toString():v);}
async function reconcilePending(){
  await Promise.all([...pending.entries()].map(async([id,hashes])=>{
    for(const hash of hashes){
      const x=await sdk.rpc<any>('skandha_explorer_getTransaction',[hash]).catch(()=>null);
      const status=String(x?.entry?.status??'').toLowerCase();
      if(['cancelled','reverted','onchain'].includes(status)||x?.admission?.outcome==='replaced')hashes.delete(hash);
    }
    if(!hashes.size)pending.delete(id);
  }));
}
function reply(res:ServerResponse,status:number,body:unknown){res.writeHead(status,{'content-type':'application/json','access-control-allow-origin':'*','access-control-allow-methods':'GET,POST,OPTIONS','access-control-allow-headers':'content-type'});res.end(json(body));}
function publish(e:Event){noteOutcome(e);appendFileSync(dataFile,json(e)+'\n');for(const c of clients)c.write(`event: ${e.type}\ndata: ${json(e)}\n\n`);console.log(e.type,e.intentId||'',e.hash||'',e.reason||'');}
function arkivError(e:unknown){arkivLastError=explainRejection(e);console.error('Arkiv:',arkivLastError);}
function hasArkivWriter(){try{return !!arkivWriter();}catch(e){arkivError(e);return false;}}
function publishToArkiv(intentId:string,signedIntent:SignedIntent){
  if(!hasArkivWriter())return;
  const task=publishIntent(signedIntent,intentId).then(({entityKey,txHash})=>{
    arkivKeys.set(intentId,entityKey);arkivPublished++;arkivLastError=null;
    publish({type:'arkiv_published',intentId,arkivKey:entityKey,txHash,time:Date.now()});
  }).catch(arkivError).finally(()=>arkivPublishing.delete(intentId));
  arkivPublishing.set(intentId,task);
}
function publishOutcome(x:Event){
  if(!hasArkivWriter()||!x.intentId||!['fill_landed','fill_refused'].includes(x.type))return;
  void (async()=>{
    await arkivPublishing.get(x.intentId!);
    const intentKey=arkivKeys.get(x.intentId!);
    if(!intentKey)throw new Error(`Arkiv intent key unavailable for ${x.intentId}`);
    // Fill reports arrive on an open endpoint: only publish an outcome the devnet itself confirms.
    if(x.type==='fill_landed'){
      const tx=await sdk.rpc<any>('skandha_explorer_getTransaction',[x.hash]).catch(()=>null);
      const status=String(tx?.entry?.status??'').toLowerCase();
      if(!['onchain','finalized'].includes(status))throw new Error(`Not publishing unconfirmed fill ${x.hash} (devnet status: ${status||'unknown'})`);
    }
    await publishFill({intentKey,filler:x.filler as `0x${string}`,outcome:x.type==='fill_landed'?'landed':'refused',txHash:x.hash,reason:x.reason});
    if(x.type==='fill_landed')await markIntent(intentKey,'filled');
    arkivLastError=null;
  })().catch(arkivError);
}
export const server=createServer(async(req,res)=>{
  if(req.method==='OPTIONS'){reply(res,204,{});return;}
  const path=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`).pathname;
  if(req.method==='GET'&&path==='/events') {res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive','access-control-allow-origin':'*'});res.write(': connected\n\n');clients.add(res);req.on('close',()=>clients.delete(res));return;}
  if(req.method==='GET'&&path==='/arkiv') {
    let writer:ReturnType<typeof arkivWriter>;
    try {writer=arkivWriter();}catch(e){arkivError(e);reply(res,500,{configured:false,writer:null,balanceTglm:null,published:arkivPublished,lastError:arkivLastError,query:ARKIV_QUERY});return;}
    if(!writer){reply(res,200,{configured:false,writer:null,balanceTglm:null,published:arkivPublished,lastError:arkivLastError,query:ARKIV_QUERY,setup:'Fund the writer and set ARKIV_PRIVATE_KEY'});return;}
    try {const balance=await writerBalance(writer.account.address);reply(res,200,{configured:true,writer:writer.account.address,balanceTglm:Number(balance)/1e18,published:arkivPublished,lastError:arkivLastError,query:ARKIV_QUERY});}
    catch(e){arkivError(e);reply(res,502,{configured:true,writer:writer.account.address,balanceTglm:null,published:arkivPublished,lastError:arkivLastError,query:ARKIV_QUERY});}
    return;
  }
  if(req.method==='GET'&&path==='/intents') {try {await reconcilePending();const block=await sdk.publicClient.getBlock();const open=await Promise.all([...intents.entries()].filter(([id,i])=>i.intent.deadline>block.timestamp && !(pending.get(id)?.size)).map(async([intentId,signedIntent])=>BigInt(await sdk.publicClient.getTransactionCount({address:signedIntent.account}))===signedIntent.intent.nonce?{intentId,signedIntent,arkivKey:arkivKeys.get(intentId)??null}:null));reply(res,200,open.filter(Boolean));}catch(e){reply(res,502,{error:explainRejection(e)});}return;}
  if(req.method==='POST'&&(path==='/intents'||path==='/events')) {
    try {let body='';for await(const chunk of req){body+=chunk;if(body.length>1_000_000)throw new Error('Request too large');}const x=JSON.parse(body);
      if(path==='/intents') {const signedIntent=await validate(x.signedIntent??x);const intentId=signedIntent.digest.toLowerCase();if(intents.has(intentId))throw new Error('Intent already posted');intents.set(intentId,signedIntent);publish({type:'intent_posted',intentId,signedIntent,time:Date.now()});publishToArkiv(intentId,signedIntent);reply(res,201,{intentId});}
      else {if(!['fill_submitted','fill_landed','fill_refused','fill_replaced'].includes(x.type))throw new Error('Invalid event type');const event={...x,arkivKey:x.intentId?arkivKeys.get(x.intentId)??null:null,reason:x.reason?explainRejection(x.reason):undefined,time:Date.now()};publish(event);publishOutcome(event);reply(res,201,{ok:true});}
    } catch(e){reply(res,400,{error:explainRejection(e)});} return;
  }
  reply(res,404,{error:'Not found'});
});
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1])server.listen(Number(process.env.PORT||8788),'0.0.0.0',()=>console.log('Kabuto relay listening on 8788'));
