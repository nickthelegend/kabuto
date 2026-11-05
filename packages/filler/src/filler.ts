/** Competitive Kabuto filler; the operator owns only its own gas-paying contract. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createWalletClient, encodeDeployData, http, parseGwei, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createKabuto, devnet1337, kabutoChain, explainRejection, type FillAttack, type SignedIntent } from '@kabuto/sdk';
import { key } from '../../devnet/src/keys.js';
import fillerArtifact from './filler-artifact.json';

const args=process.argv.slice(2);
const opt=(name:string,defaultValue:string)=>{const i=args.indexOf(name);return i<0?defaultValue:args[i+1]??defaultValue;};
const name=opt('--name',opt('--role','a')).replace(/^filler-/,'');
if(!['a','b'].includes(name))throw new Error('Use --name a or --name b');
const role=`filler-${name}`;
const attack=opt('--mode',args.includes('--attack')?'extra-sender':'') as FillAttack|'';
const minProfitBps=Number(opt('--minProfitBps','0'));
const userShareBps=Number(opt('--userShareBps',name==='b'?'7500':'5000'));
const tip=parseGwei(opt('--tipGwei',name==='b'?'2':'0.1'));
const relayUrl=opt('--relay','http://127.0.0.1:8788');
if(!Number.isInteger(minProfitBps)||minProfitBps<0||!Number.isInteger(userShareBps)||userShareBps<0||userShareBps>10000)throw new Error('Invalid bps');
const sdk=createKabuto();
const pk=key(role),operator=privateKeyToAccount(pk).address;
const stateFile=fileURLToPath(new URL(`../data/${role}.json`,import.meta.url));
const wallet=createWalletClient({account:privateKeyToAccount(pk),chain:kabutoChain,transport:http(devnet1337.gateway)});
const json=(x:unknown)=>JSON.stringify(x,(_k,v)=>typeof v==='bigint'?v.toString():v);
const report=async(x:Record<string,unknown>)=>{const r=await fetch(`${relayUrl}/events`,{method:'POST',headers:{'content-type':'application/json'},body:json(x)});if(!r.ok)throw new Error(`Relay event failed: ${r.status} ${await r.text()}`);};
async function ensureFiller():Promise<Address> {
  if(existsSync(stateFile)){const s=JSON.parse(readFileSync(stateFile,'utf8'));if(s.filler&&await sdk.publicClient.getCode({address:s.filler}))return s.filler;}
  if(await sdk.publicClient.getBalance({address:operator})<120_000_000_000_000_000n){await sdk.rpc('skandha_explorer_faucet',[operator]);for(let i=0;i<60;i++){if(await sdk.publicClient.getBalance({address:operator})>=120_000_000_000_000_000n)break;await new Promise(r=>setTimeout(r,2000));}}
  const data=encodeDeployData({abi:fillerArtifact.abi as any,bytecode:fillerArtifact.bytecode as Hex,args:[devnet1337.predeploys.poolManager,operator]});
  const gas=await sdk.publicClient.estimateGas({account:wallet.account,data,value:100_000_000_000_000_000n});
  const hash=await wallet.sendTransaction({data,value:100_000_000_000_000_000n,gas:gas*2n,gasPrice:2_000_000n,type:'legacy'} as any);
  const receipt=await sdk.publicClient.waitForTransactionReceipt({hash,timeout:180_000});
  if(receipt.status!=='success'||!receipt.contractAddress)throw new Error(`Filler deployment failed ${hash}`);
  writeFileSync(stateFile,json({filler:receipt.contractAddress,operator,hash}));
  console.log(role,'deployed',receipt.contractAddress,hash);
  return receipt.contractAddress;
}
const filler=await ensureFiller();
const seen=new Set<string>();
function decode(x:any):SignedIntent {return {...x,intent:{...x.intent,maxIn:BigInt(x.intent.maxIn),startOut:BigInt(x.intent.startOut),endOut:BigInt(x.intent.endOut),startTime:BigInt(x.intent.startTime),deadline:BigInt(x.intent.deadline),nonce:BigInt(x.intent.nonce)}};}
const decayAbi=[{type:'function',name:'decayedMinOut',stateMutability:'pure',inputs:[{type:'uint256'},{type:'uint256'},{type:'uint64'},{type:'uint64'},{type:'uint256'}],outputs:[{type:'uint256'}]}] as const;
async function processIntent(intentId:string,raw:any) {
  if(seen.has(intentId))return;seen.add(intentId);
  const signedIntent=decode(raw),i=signedIntent.intent;
  let submittedHash:Hex|undefined;
  try {
    const block=await sdk.publicClient.getBlock();
    if(block.timestamp>=i.deadline)return;
    const zfo=i.tokenIn.toLowerCase()===devnet1337.poolKey.currency0.toLowerCase();
    const [q,minimum]=await Promise.all([sdk.quote({zeroForOne:zfo,amountIn:i.maxIn}),sdk.publicClient.readContract({address:signedIntent.account,abi:decayAbi,functionName:'decayedMinOut',args:[i.startOut,i.endOut,i.startTime,i.deadline,block.timestamp]})]);
    if(q.amountOut*10000n<minimum*BigInt(10000+minProfitBps)){console.log(role,'waiting for profitable quote',intentId);seen.delete(intentId);return;}
    const surplus=q.amountOut-minimum;
    const payOut=minimum+surplus*BigInt(userShareBps)/10000n;
    const tx=await sdk.buildFill({signedIntent,filler,operatorKey:pk,amountIn:i.maxIn,payOut,tip,attack:attack||undefined});
    const tracker=await sdk.submitFill(tx);submittedHash=tracker.hash;
    await report({type:'fill_submitted',intentId,hash:tracker.hash,filler,role,attack:attack||undefined,payOut});
    console.log(role,'submitted',tracker.hash,intentId);
    for await(const e of tracker.events()) {
      if(e.status==='onchain'){await report({type:'fill_landed',intentId,hash:e.hash,filler,role,attack:attack||undefined});console.log(role,'landed',e.hash);break;}
      if(e.status==='cancelled'){
        const used=BigInt(await sdk.publicClient.getTransactionCount({address:signedIntent.account}))>i.nonce;
        await report({type:used?'fill_replaced':'fill_refused',intentId,hash:e.hash,reason:used?undefined:'Cancelled before inclusion',filler,role,attack:attack||undefined});
        console.log(role,used?'replaced':'cancelled',e.hash);break;
      }
      if(e.status==='reverted'){await report({type:'fill_refused',intentId,hash:e.hash,reason:'Atomic fill reverted',filler,role,attack:attack||undefined});console.log(role,'reverted',e.hash);break;}
    }
  } catch(e) {const reason=explainRejection(e);if(!submittedHash)await report({type:'fill_refused',intentId,reason,filler,role,attack:attack||undefined}).catch(console.error);console.error(role,submittedHash?'still pending':'refused',intentId,reason);}
}
async function openIntents(){const r=await fetch(`${relayUrl}/intents`);if(!r.ok)throw new Error(`Relay GET /intents ${r.status}`);return await r.json() as Array<{intentId:string;signedIntent:unknown}>;}
for(const x of await openIntents())void processIntent(x.intentId,x.signedIntent);
if(attack){console.log(role,'attack mode',attack);setTimeout(()=>process.exit(0),180_000);}
else {
  setInterval(()=>{void openIntents().then(xs=>Promise.all(xs.map(x=>processIntent(x.intentId,x.signedIntent)))).catch(e=>console.error(role,'refresh',e));},5000);
  while(true){
    try {const response=await fetch(`${relayUrl}/events`,{headers:{accept:'text/event-stream'}});if(!response.ok||!response.body)throw new Error(`Relay SSE ${response.status}`);
      console.log(role,'subscribed',relayUrl,'minProfitBps',minProfitBps,'userShareBps',userShareBps,'tip',tip.toString());
      const reader=response.body.getReader();const decoder=new TextDecoder();let buffer='';
      while(true){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let end;
        while((end=buffer.indexOf('\n\n'))>=0){const chunk=buffer.slice(0,end);buffer=buffer.slice(end+2);const line=chunk.split('\n').find(x=>x.startsWith('data: '));if(!line)continue;const ev=JSON.parse(line.slice(6));if(ev.type==='intent_posted')void processIntent(ev.intentId,ev.signedIntent);}
      }
    }catch(e){console.error(role,'SSE reconnect',e);await new Promise(r=>setTimeout(r,2000));}
  }
}
