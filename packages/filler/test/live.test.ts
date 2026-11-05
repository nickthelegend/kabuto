import { afterAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createWalletClient, encodeFunctionData, erc20Abi, http, parseEther, parseUnits, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createKabuto, devnet1337, kabutoChain, secp256k1Signer, type SignedIntent } from '@kabuto/sdk';
import { key } from '../../devnet/src/keys.js';
import { server } from '../src/relay.js';

const sdk=createKabuto(),pk=key('sdk-funder'),owner=secp256k1Signer(key('sdk-owner'));
const funder=privateKeyToAccount(pk).address;
const dir=fileURLToPath(new URL('../',import.meta.url)),eventsFile=fileURLToPath(new URL('../data/intents.jsonl',import.meta.url)),stateFile=fileURLToPath(new URL('../data/test-state.json',import.meta.url));
const children:ChildProcess[]=[];
let port=0,account:Address,setupReady=false,raceReady=false;
const json=(x:unknown)=>JSON.stringify(x,(_k,v)=>typeof v==='bigint'?v.toString():v);
const wait=async(fn:()=>Promise<boolean>|boolean,timeout=180000)=>{const start=Date.now();while(Date.now()-start<timeout){if(await fn())return;await new Promise(r=>setTimeout(r,1000));}throw new Error('Timed out waiting for live relay/filler result');};
const events=(intentId:string)=>existsSync(eventsFile)?readFileSync(eventsFile,'utf8').split('\n').filter(Boolean).map(x=>JSON.parse(x)).filter(x=>x.intentId===intentId):[];
const startBot=(args:string[])=>{const child=spawn(process.execPath,['--import','tsx','src/filler.ts',...args],{cwd:dir,stdio:['ignore','pipe','pipe']});children.push(child);let log='';child.stdout?.on('data',x=>{log+=x.toString();});child.stderr?.on('data',x=>{log+=x.toString();});return {child,ready:()=>log.includes('subscribed')||log.includes('attack mode'),log:()=>log};};
const stop=async(child:ChildProcess)=>{if(!child.pid||child.exitCode!==null||child.signalCode)return;process.kill(child.pid,'SIGTERM');await Promise.race([once(child,'exit'),new Promise(r=>setTimeout(r,5000))]);if(child.exitCode===null&&!child.signalCode)process.kill(child.pid,'SIGKILL');};
afterAll(async()=>{for(const c of children)await stop(c);await new Promise<void>(resolve=>server.close(()=>resolve()));});
async function ensureFunded(address:Address,min:bigint){if(await sdk.publicClient.getBalance({address})>=min)return;await sdk.rpc('skandha_explorer_faucet',[address]);await wait(async()=>await sdk.publicClient.getBalance({address})>=min,120000);}
async function post(signedIntent:SignedIntent){const response=await fetch(`http://127.0.0.1:${port}/intents`,{method:'POST',headers:{'content-type':'application/json'},body:json(signedIntent)});const body=await response.json() as any;if(!response.ok)throw new Error(`Relay POST /intents: ${json(body)}`);return body.intentId as string;}
async function intent(){const amountIn=parseUnits('10',6),q=await sdk.quote({zeroForOne:!devnet1337.wethIs0,amountIn}),block=await sdk.publicClient.getBlock();return sdk.signIntent({account,signer:owner,tokenIn:devnet1337.kusd as Address,maxIn:amountIn,tokenOut:devnet1337.predeploys.weth as Address,startOut:q.amountOut*99n/100n,endOut:q.amountOut*98n/100n,startTime:block.timestamp,deadline:block.timestamp+600n});}

describe.sequential('live open filler network',()=>{
  it('deploys and stakes a funded intent account',async()=>{
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',()=>{port=(server.address() as any).port;resolve();}));
    const state: {account?:Address;stakeHash?:Hex}=existsSync(stateFile)?JSON.parse(readFileSync(stateFile,'utf8')):{};
    if(state.account&&await sdk.publicClient.getCode({address:state.account})) account=state.account;
    else {await ensureFunded(funder,parseEther('0.08'));const deployed=await sdk.deployAccount({funderKey:pk,owner:owner.address,value:parseEther('0.05')});account=deployed.address;state.account=account;writeFileSync(stateFile,json(state));console.log('LIVE_TX',deployed.hash);}
    const w=createWalletClient({account:privateKeyToAccount(pk),chain:kabutoChain,transport:http(devnet1337.gateway)});
    const tokenBal=await sdk.publicClient.readContract({address:devnet1337.kusd as Address,abi:erc20Abi,functionName:'balanceOf',args:[account]});
    if(tokenBal<parseUnits('100',6)){
      const data=encodeFunctionData({abi:[{type:'function',name:'faucet',stateMutability:'nonpayable',inputs:[{type:'address'}],outputs:[]}],functionName:'faucet',args:[account]});
      const gas=await sdk.publicClient.estimateGas({account:w.account,to:devnet1337.kusd as Address,data});
      const h=await w.sendTransaction({to:devnet1337.kusd as Address,data,gas:gas*2n,gasPrice:2_000_000n,type:'legacy'} as any);expect((await sdk.publicClient.waitForTransactionReceipt({hash:h,timeout:180000})).status).toBe('success');console.log('LIVE_TX',h);
    }
    const registryAbi=[{type:'function',name:'getDepositInfo',stateMutability:'view',inputs:[{type:'address'}],outputs:[{type:'uint256'},{type:'uint32'},{type:'uint64'}]}] as const;
    const [stake]=await sdk.publicClient.readContract({address:devnet1337.predeploys.stakingRegistry as Address,abi:registryAbi,functionName:'getDepositInfo',args:[account]});
    if(stake===0n){
      if(!state.stakeHash){const tx=await sdk.stakeAccount({account,signer:owner,value:parseEther('0.012'),maxFeePerGas:8_000_000_000n,tip:4_000_000_000n});state.stakeHash=tx.hash;writeFileSync(stateFile,json(state));console.log('LIVE_TX',tx.hash);}
      expect((await sdk.publicClient.waitForTransactionReceipt({hash:state.stakeHash!,timeout:120000})).status).toBe('success');
    }
    setupReady=true;
  });
  it('posts a verified intent; two fillers race and exactly one lands',async()=>{
    expect(setupReady,'Account staking must land before the filler race').toBe(true);
    const currentNonce=BigInt(await sdk.publicClient.getTransactionCount({address:account}));
    const mempool=await sdk.rpc<any>('skandha_explorer_listTransactions',[]);
    const blocking=mempool.items?.find((x:any)=>x.sender?.toLowerCase()===account.toLowerCase()&&BigInt(x.nonce)===currentNonce&&['New','Pending','Submitted'].includes(x.status));
    if(blocking)throw new Error(`Existing devnet frame tx ${blocking.txHash} is still ${blocking.status} at account nonce ${currentNonce}`);
    const w=createWalletClient({account:privateKeyToAccount(pk),chain:kabutoChain,transport:http(devnet1337.gateway)});
    const bAddress=privateKeyToAccount(key('filler-b')).address;
    if(await sdk.publicClient.getBalance({address:bAddress})<parseEther('0.12')){
      const topUp=await w.sendTransaction({to:bAddress,value:parseEther('0.03'),gas:21000n,gasPrice:2_000_000n,type:'legacy'} as any);
      expect((await sdk.publicClient.waitForTransactionReceipt({hash:topUp,timeout:180000})).status).toBe('success');console.log('LIVE_TX',topUp);
    }
    const a=startBot(['--name','a','--relay',`http://127.0.0.1:${port}`]);const b=startBot(['--name','b','--minProfitBps','5','--tipGwei','2','--relay',`http://127.0.0.1:${port}`]);
    await wait(()=>a.ready()&&b.ready());
    try {
      const si=await intent();const id=await post(si);
      try {await wait(()=>events(id).filter(x=>['fill_landed','fill_replaced','fill_refused'].includes(x.type)).length>=2,135000);}
      catch {throw new Error(`Filler race is still pending on the live devnet after 135 s: ${json(events(id).map(x=>({type:x.type,hash:x.hash,reason:x.reason})))}`);}
      const e=events(id);expect(e.filter(x=>x.type==='fill_landed')).toHaveLength(1);expect(e.filter(x=>x.type==='fill_replaced'||x.type==='fill_refused')).toHaveLength(1);
      console.log('LIVE_TX',e.find(x=>x.type==='fill_landed')?.hash);
      const paid=await sdk.publicClient.readContract({address:devnet1337.predeploys.weth as Address,abi:erc20Abi,functionName:'balanceOf',args:[account]});expect(paid).toBeGreaterThanOrEqual(si.intent.startOut);raceReady=true;
    } finally {await stop(a.child);await stop(b.child);} 
  });
  it('matches contract Dutch decay arithmetic',async()=>{
    expect(account,'Account setup requires the live devnet faucet').toBeDefined();
    const i=(await intent()).intent,t=i.startTime+123n;
    const local=i.startOut-(i.startOut-i.endOut)*(t-i.startTime)/(i.deadline-i.startTime);
    const abi=[{type:'function',name:'decayedMinOut',stateMutability:'pure',inputs:[{type:'uint256'},{type:'uint256'},{type:'uint64'},{type:'uint64'},{type:'uint256'}],outputs:[{type:'uint256'}]}] as const;
    const onchain=await sdk.publicClient.readContract({address:account,abi,functionName:'decayedMinOut',args:[i.startOut,i.endOut,i.startTime,i.deadline,t]});expect(onchain).toBe(local);
  });
  it('refuses extra-sender, over-max, no-atomic, and rolls back underpay',async()=>{
    expect(raceReady,'A confirmed filler race is required before attack demos').toBe(true);
    const si=await intent(),id=await post(si);
    const tokenBalance=(token:Address)=>sdk.publicClient.readContract({address:token,abi:erc20Abi,functionName:'balanceOf',args:[account]});
    const inBefore=await tokenBalance(devnet1337.kusd as Address),outBefore=await tokenBalance(devnet1337.predeploys.weth as Address);
    for(const mode of ['extra-sender','over-max','no-atomic','underpay']){
      const bot=startBot(['--name','a','--attack','--mode',mode,'--relay',`http://127.0.0.1:${port}`]);
      await wait(()=>events(id).some(x=>x.attack===mode&&x.type==='fill_refused'));
      const found=events(id).find(x=>x.attack===mode&&x.type==='fill_refused');expect(found?.reason).toBeTruthy();expect(String(found.reason).toLowerCase()).toContain(mode==='underpay'?'revert':mode);
      await stop(bot.child);
    }
    expect(await tokenBalance(devnet1337.kusd as Address)).toBe(inBefore);
    expect(await tokenBalance(devnet1337.predeploys.weth as Address)).toBe(outBefore);
  });
});
