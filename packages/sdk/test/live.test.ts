import { describe, expect, it } from 'vitest';
import { createWalletClient, encodeDeployData, encodeFunctionData, erc20Abi, http, parseEther, parseUnits, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createKabuto, devnet1337, kabutoChain, secp256k1Signer, explainRejection } from '../src/index.js';
import { key } from '../../devnet/src/keys.js';
import fillerArtifact from '../../filler/src/filler-artifact.json';

const sdk=createKabuto();
const funderKey=key('sdk-funder'),ownerKey=key('sdk-owner'),operatorKey=key('sdk-filler');
const funder=privateKeyToAccount(funderKey),operator=privateKeyToAccount(operatorKey);
const signer=secp256k1Signer(ownerKey);
const wallet=(pk:Hex)=>createWalletClient({account:privateKeyToAccount(pk),chain:kabutoChain,transport:http(devnet1337.gateway)});
const ensure=async(addr:Address,min:bigint)=>{if(await sdk.publicClient.getBalance({address:addr})>=min)return;await sdk.rpc('skandha_explorer_faucet',[addr]);for(let i=0;i<60;i++){if(await sdk.publicClient.getBalance({address:addr})>=min)return;await new Promise(r=>setTimeout(r,2000));}throw new Error(`Faucet did not fund ${addr}`);};
const legacy=async(pk:Hex,to:Address,data:Hex)=>{const w=wallet(pk);const gas=await sdk.publicClient.estimateGas({account:w.account,to,data});const hash=await w.sendTransaction({to,data,gas:gas*2n,gasPrice:2_000_000n,type:'legacy'} as any);const r=await sdk.publicClient.waitForTransactionReceipt({hash,timeout:180_000});expect(r.status).toBe('success');return hash;};
const balance=(t:Address,a:Address)=>sdk.publicClient.readContract({address:t,abi:erc20Abi,functionName:'balanceOf',args:[a]});
async function landed(tracker:{hash:Hex}){const r=await sdk.publicClient.waitForTransactionReceipt({hash:tracker.hash,timeout:180_000});expect(r.status).toBe('success');console.log('LIVE_TX',tracker.hash);return r;}

describe.sequential('live Kabuto SDK devnet',()=>{
  let account:Address,filler:Address;
  it('deploys and stakes an account',async()=>{
    await ensure(funder.address,parseEther('0.3'));
    const d=await sdk.deployAccount({funderKey,owner:signer.address,value:parseEther('0.05')});account=d.address;console.log('LIVE_TX',d.hash);
    await legacy(funderKey,devnet1337.kusd as Address,encodeFunctionData({abi:[{type:'function',name:'faucet',stateMutability:'nonpayable',inputs:[{type:'address'}],outputs:[]}],functionName:'faucet',args:[account]}));
    await landed(await sdk.stakeAccount({account,signer,value:parseEther('0.012')}));
    expect(await balance(devnet1337.kusd as Address,account)).toBeGreaterThan(parseUnits('100',6));
  });
  it('lands a protected swap and refuses an excluded band without gas',async()=>{
    expect(account,'Account setup requires a funded devnet faucet').toBeDefined();
    const zfo=!devnet1337.wethIs0;
    await landed(await sdk.protectedSwap({account,signer,zeroForOne:zfo,amountIn:parseUnits('10',6),bandBps:100}));
    const p=await sdk.poolPrice(),eth=await sdk.publicClient.getBalance({address:account});
    await expect(sdk.protectedSwap({account,signer,zeroForOne:zfo,amountIn:parseUnits('10',6),bandBps:{min:p.sqrtPriceX96*2n,max:p.sqrtPriceX96*3n}})).rejects.toThrow();
    expect(await sdk.publicClient.getBalance({address:account})).toBe(eth);
  });
  it('sponsors a swap without changing account ETH',async()=>{
    expect(account,'Account setup requires a funded devnet faucet').toBeDefined();
    const eth=await sdk.publicClient.getBalance({address:account});
    await landed(await sdk.sponsoredSwap({account,signer,zeroForOne:!devnet1337.wethIs0,amountIn:parseUnits('10',6),bandBps:100}));
    expect(await sdk.publicClient.getBalance({address:account})).toBe(eth);
  });
  it('rejects three tampered fills, then lands an open intent',async()=>{
    expect(account,'Account setup requires a funded devnet faucet').toBeDefined();
    await ensure(operator.address,parseEther('0.12'));
    const data=encodeDeployData({abi:fillerArtifact.abi as any,bytecode:fillerArtifact.bytecode as Hex,args:[devnet1337.predeploys.poolManager,operator.address]});
    const w=wallet(operatorKey),gas=await sdk.publicClient.estimateGas({account:w.account,data,value:parseEther('0.1')});
    const h=await w.sendTransaction({data,value:parseEther('0.1'),gas:gas*2n,gasPrice:2_000_000n,type:'legacy'} as any);
    const r=await sdk.publicClient.waitForTransactionReceipt({hash:h,timeout:180_000});expect(r.status).toBe('success');filler=r.contractAddress!;console.log('LIVE_TX',h);
    const amountIn=parseUnits('10',6),q=await sdk.quote({zeroForOne:!devnet1337.wethIs0,amountIn}),b=await sdk.publicClient.getBlock();
    const startOut=q.amountOut*99n/100n;
    const si=await sdk.signIntent({account,signer,tokenIn:devnet1337.kusd as Address,maxIn:amountIn,tokenOut:devnet1337.predeploys.weth as Address,startOut,endOut:q.amountOut*98n/100n,startTime:b.timestamp,deadline:b.timestamp+600n});
    for(const attack of ['extra-sender','over-max','no-atomic'] as const){
      const tx=await sdk.buildFill({signedIntent:si,filler,operatorKey,amountIn,payOut:startOut,attack});
      try {const tracker=await sdk.submitFill(tx);throw new Error(`Attack ${attack} was admitted: ${tracker.hash}`);}catch(e){const x=explainRejection(e);console.log('ATTACK_REFUSED',attack,x);expect(x.toLowerCase()).toMatch(attack==='extra-sender'?/extra-sender|shape\(9\)/:attack==='over-max'?/over-max|shape\(6\)/:/no-atomic|shape\(7\)/);}
    }
    const before=await balance(devnet1337.predeploys.weth as Address,account);
    await landed(await sdk.submitFill(await sdk.buildFill({signedIntent:si,filler,operatorKey,amountIn,payOut:startOut})));
    expect((await balance(devnet1337.predeploys.weth as Address,account))-before).toBeGreaterThanOrEqual(startOut);
  });
});
