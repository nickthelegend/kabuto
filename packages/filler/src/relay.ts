/** Untrusted, self-authenticating intent bulletin board. Anyone may run a relay. */
import { createServer, type ServerResponse } from 'node:http';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { recoverAddress, hexToBytes, isAddress, isHex, type Address, type Hex } from 'viem';
import { p256 } from '@noble/curves/p256';
import { createKabuto, explainRejection, type SignedIntent } from '@kabuto/sdk';

const sdk=createKabuto();
const dataFile=fileURLToPath(new URL('../data/intents.jsonl',import.meta.url));
mkdirSync(fileURLToPath(new URL('../data/',import.meta.url)),{recursive:true});
type Event={type:string;intentId?:string;hash?:Hex;reason?:string;time:number;[key:string]:unknown};
const clients=new Set<ServerResponse>();
const intents=new Map<string,SignedIntent>();
const pending=new Map<string,Set<string>>();
function noteOutcome(x:any){if(!x.intentId||!x.hash)return;const set=pending.get(x.intentId)??new Set<string>();if(x.type==='fill_submitted')set.add(String(x.hash).toLowerCase());if(['fill_landed','fill_refused','fill_replaced'].includes(x.type))set.delete(String(x.hash).toLowerCase());pending.set(x.intentId,set);}
if(existsSync(dataFile)) for(const line of readFileSync(dataFile,'utf8').split('\n')) if(line.trim()) {
  try {const x=JSON.parse(line);if(x.type==='intent_posted') intents.set(x.intentId,decodeIntent(x.signedIntent));noteOutcome(x);} catch(e){console.error('Invalid persisted relay line:',e);}
}
function json(value:unknown){return JSON.stringify(value,(_k,v)=>typeof v==='bigint'?v.toString():v);}
function decodeIntent(x:any):SignedIntent {return {...x,intent:{...x.intent,maxIn:BigInt(x.intent.maxIn),startOut:BigInt(x.intent.startOut),endOut:BigInt(x.intent.endOut),startTime:BigInt(x.intent.startTime),deadline:BigInt(x.intent.deadline),nonce:BigInt(x.intent.nonce)}};}
async function validate(x:any):Promise<SignedIntent> {
  if(!x||!x.intent||!isAddress(x.account)||!isAddress(x.owner)||!isHex(x.digest)||!isHex(x.signature)) throw new Error('Malformed SignedIntent');
  const i=decodeIntent(x);
  if(!isAddress(i.intent.tokenIn)||!isAddress(i.intent.tokenOut)||i.intent.maxIn<=0n||i.intent.startOut<i.intent.endOut||i.intent.endOut<=0n) throw new Error('Invalid intent parameters');
  const block=await sdk.publicClient.getBlock();
  if(i.intent.deadline<=block.timestamp) throw new Error('Intent expired');
  if(i.intent.startTime>i.intent.deadline) throw new Error('Invalid intent times');
  if(BigInt(await sdk.publicClient.getTransactionCount({address:i.account}))!==i.intent.nonce) throw new Error('Intent nonce is already used');
  const abi=[{type:'function',name:'owner',stateMutability:'view',inputs:[],outputs:[{type:'address'}]},{type:'function',name:'intentDigest',stateMutability:'view',inputs:[{type:'tuple',components:[{name:'tokenIn',type:'address'},{name:'maxIn',type:'uint256'},{name:'tokenOut',type:'address'},{name:'startOut',type:'uint256'},{name:'endOut',type:'uint256'},{name:'startTime',type:'uint64'},{name:'deadline',type:'uint64'},{name:'nonce',type:'uint256'}]}],outputs:[{type:'bytes32'}]}] as const;
  const [owner,digest]=await Promise.all([sdk.publicClient.readContract({address:i.account,abi,functionName:'owner'}),sdk.publicClient.readContract({address:i.account,abi,functionName:'intentDigest',args:[i.intent]})]);
  if(owner.toLowerCase()!==i.owner.toLowerCase()||digest.toLowerCase()!==i.digest.toLowerCase()) throw new Error('Owner or digest mismatch');
  if(i.scheme==='secp256k1') {
    if(i.signature.length!==132) throw new Error('Malformed secp256k1 signature');
    const parity=Number.parseInt(i.signature.slice(2,4),16);
    const recovered=await recoverAddress({hash:digest,signature:{r:`0x${i.signature.slice(4,68)}`,s:`0x${i.signature.slice(68,132)}`,yParity:parity} as any});
    if(recovered.toLowerCase()!==owner.toLowerCase()) throw new Error('BadIntentSignature');
  } else if(i.scheme==='p256') {
    if(i.signature.length!==258) throw new Error('Malformed P256 signature');
    const bytes=hexToBytes(i.signature),pub=bytes.slice(64),sig=bytes.slice(0,64);
    const {keccak256,bytesToHex}=await import('viem');
    const addr=`0x${keccak256(bytesToHex(pub)).slice(26)}`;
    if(addr.toLowerCase()!==owner.toLowerCase()||!p256.verify(sig,hexToBytes(digest),new Uint8Array([4,...pub]),{lowS:true,prehash:false})) throw new Error('BadIntentSignature');
  } else throw new Error('Unknown signature scheme');
  return i;
}
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
export const server=createServer(async(req,res)=>{
  if(req.method==='OPTIONS'){reply(res,204,{});return;}
  const path=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`).pathname;
  if(req.method==='GET'&&path==='/events') {res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive','access-control-allow-origin':'*'});res.write(': connected\n\n');clients.add(res);req.on('close',()=>clients.delete(res));return;}
  if(req.method==='GET'&&path==='/intents') {try {await reconcilePending();const block=await sdk.publicClient.getBlock();const open=await Promise.all([...intents.entries()].filter(([id,i])=>i.intent.deadline>block.timestamp && !(pending.get(id)?.size)).map(async([intentId,signedIntent])=>BigInt(await sdk.publicClient.getTransactionCount({address:signedIntent.account}))===signedIntent.intent.nonce?{intentId,signedIntent}:null));reply(res,200,open.filter(Boolean));}catch(e){reply(res,502,{error:explainRejection(e)});}return;}
  if(req.method==='POST'&&(path==='/intents'||path==='/events')) {
    try {let body='';for await(const chunk of req){body+=chunk;if(body.length>1_000_000)throw new Error('Request too large');}const x=JSON.parse(body);
      if(path==='/intents') {const signedIntent=await validate(x.signedIntent??x);const intentId=signedIntent.digest.toLowerCase();if(intents.has(intentId))throw new Error('Intent already posted');intents.set(intentId,signedIntent);publish({type:'intent_posted',intentId,signedIntent,time:Date.now()});reply(res,201,{intentId});}
      else {if(!['fill_submitted','fill_landed','fill_refused','fill_replaced'].includes(x.type))throw new Error('Invalid event type');const event={...x,reason:x.reason?explainRejection(x.reason):undefined,time:Date.now()};publish(event);reply(res,201,{ok:true});}
    } catch(e){reply(res,400,{error:explainRejection(e)});} return;
  }
  reply(res,404,{error:'Not found'});
});
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1])server.listen(Number(process.env.PORT||8788),'0.0.0.0',()=>console.log('Kabuto relay listening on 8788'));
