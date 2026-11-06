/** Kabuto devnet SDK. EIP-8141 support is experimental and chain 1337 only. */
import { createPublicClient, createWalletClient, defineChain, http, encodeDeployData, encodeFunctionData, erc20Abi, bytesToHex, hexToBytes, keccak256, type Address, type Hex, type Chain, type PublicClient } from 'viem';
import { privateKeyToAccount, sign } from 'viem/accounts';
import { p256 } from '@noble/curves/p256';
import { profile } from '@forshtat/hegota-support/profiles/ethrex-eip8141-tracer';
import { frame, newTx, signTx, sigHash } from '@forshtat/hegota-support/tx';
import { toWire } from '@forshtat/hegota-support/rpc';
import deploymentJson from '../../../deployments/1337.json';
import accountArtifact from './KabutoAccount.json';
import routerArtifact from './KabutoRouter.json';
import paymasterArtifact from './KabutoPaymaster.json';
import fillerArtifact from './KabutoFiller.json';

/** The shared public devnet deployment. */
export const devnet1337 = deploymentJson;
/** The live devnet chain, restricted to chain ID 1337. */
export const kabutoChain: Chain = defineChain({ id: 1337, name: 'Kabuto EIP-8141 devnet', nativeCurrency: {name:'Ether',symbol:'ETH',decimals:18}, rpcUrls:{default:{http:[devnet1337.gateway]}} });
export type Deployment = typeof devnet1337;
export type Intent = { tokenIn: Address; maxIn: bigint; tokenOut: Address; startOut: bigint; endOut: bigint; startTime: bigint; deadline: bigint; nonce: bigint };
export type Scheme = 'secp256k1' | 'p256';
export type QuoteSide = 'buy' | 'sell' | 'zeroForOne' | 'oneForZero';
export type KabutoSigner = { address: Address; scheme: Scheme; signHash(hash32: Hex): Promise<Hex> };
export type SignedIntent = { intent: Intent; digest: Hex; signature: Hex; account: Address; owner: Address; scheme: Scheme };
export type Lifecycle = { status: 'admitted' | 'pending' | 'onchain' | 'cancelled' | 'reverted' | 'replaced' | 'rejected'; hash: Hex; block?: bigint; index?: number; frames?: unknown; admission?: unknown };
export type FillAttack = 'extra-sender' | 'over-max' | 'no-atomic' | 'underpay';
export type FrameTx = ReturnType<typeof newTx>;
export type Tracker = AsyncIterable<Lifecycle> & { hash: Hex; events: (callback?: (event: Lifecycle) => void) => AsyncGenerator<Lifecycle>; wait: () => Promise<Lifecycle> };
const accountAbi = accountArtifact.abi as any;
const routerAbi = routerArtifact.abi as any;
const paymasterAbi = paymasterArtifact.abi as any;
const fillerAbi = fillerArtifact.abi as any;
const slotAbi = [{type:'function',name:'getSlot0',stateMutability:'view',inputs:[{type:'bytes32'}],outputs:[{type:'uint160'},{type:'int24'},{type:'uint24'},{type:'uint24'}]}] as const;
const poolKeyAbi = {type:'tuple',components:[{name:'currency0',type:'address'},{name:'currency1',type:'address'},{name:'fee',type:'uint24'},{name:'tickSpacing',type:'int24'},{name:'hooks',type:'address'}]} as const;
const quoteAbi = [{type:'function',name:'quoteExactInputSingle',stateMutability:'nonpayable',inputs:[{type:'tuple',name:'p',components:[{...poolKeyAbi,name:'poolKey'},{name:'zeroForOne',type:'bool'},{name:'exactAmount',type:'uint128'},{name:'hookData',type:'bytes'}]}],outputs:[{type:'uint256'},{type:'uint256'}]}] as const;
const stakeAbi = [{type:'function',name:'addStake',stateMutability:'payable',inputs:[{type:'uint32'}],outputs:[]}] as const;
const sleep = (ms:number) => new Promise(r=>setTimeout(r,ms));
const pad = (n:bigint) => n.toString(16).padStart(64,'0');
function assertHash(h: Hex) { if (!/^0x[0-9a-fA-F]{64}$/.test(h)) throw new Error('Expected a 32-byte hash'); }

/** Create a secp256k1 owner or operator signer. Never persist private keys in SDK state. */
/**
 * MAX_VERIFY_GAS (100,000) caps the SUM of every VERIFY frame's execution limit plus a per-signature cost:
 * 2,800 for secp256k1, 6,700 for P256 (the ERC-8421 sidecar's SIGNATURE_VERIFICATION_GAS_COST).
 */
export const MAX_VERIFY_GAS = 100_000n;
export const SIGNATURE_GAS: Record<Scheme, bigint> = { secp256k1: 2_800n, p256: 6_700n };
export const FILLER_PAY_GAS = 12_000n;
/** Execution limit left for verifyIntent once the filler's pay() frame and both signatures are paid for. */
export function intentVerifyBudget(ownerScheme: Scheme): bigint {
  return MAX_VERIFY_GAS - SIGNATURE_GAS[ownerScheme] - SIGNATURE_GAS.secp256k1 - FILLER_PAY_GAS;
}

export function secp256k1Signer(privKeyHex: Hex): KabutoSigner {
  const address = privateKeyToAccount(privKeyHex).address;
  return { address, scheme:'secp256k1', async signHash(hash32) {
    assertHash(hash32);
    const s = await sign({hash:hash32,privateKey:privKeyHex});
    return `0x${(s.yParity ?? Number(s.v)-27).toString(16).padStart(2,'0')}${s.r.slice(2)}${s.s.slice(2)}` as Hex;
  }};
}
/** Create a P256 signer; its EIP-8141 address is keccak256(qx || qy)[12:]. */
export function p256Signer(privKeyHex: Hex): KabutoSigner {
  const pub = p256.getPublicKey(hexToBytes(privKeyHex),false);
  const address = `0x${keccak256(bytesToHex(pub.slice(1))).slice(26)}` as Address;
  return {address,scheme:'p256',async signHash(hash32) {
    assertHash(hash32);
    const s=p256.sign(hexToBytes(hash32),hexToBytes(privKeyHex),{lowS:true,prehash:false});
    return `0x${pad(s.r)}${pad(s.s)}${bytesToHex(pub.slice(1)).slice(2)}` as Hex;
  }};
}

/** Convert known admission errors and intent shape codes to readable text. */
export function explainRejection(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const lower=raw.toLowerCase();
  if (lower.includes('8ad5a9c0') || lower.includes('priceoutofband')) return 'PriceOutOfBand: pool price left the signed band; refused before gas is charged.';
  if (lower.includes('9cf7c987') || lower.includes('badintentshape')) {
    const match=raw.match(/9cf7c987(?:[0-9a-fA-F]{64})?([0-9a-fA-F]{64})/i);
    const code=match ? Number(BigInt(`0x${match[1]}`)) : Number(raw.match(/BadIntentShape\((\d+)\)/)?.[1] || 0);
    const names:Record<number,string>={1:'nonce mismatch',2:'too few frames',3:'payment VERIFY missing',4:'token transfer must be a SENDER frame',5:'wrong input token',6:'over-max or malformed transfer',7:'no-atomic frame',8:'value transfer forbidden',9:'extra-sender frame',10:'settlement must be a SENDER frame',11:'wrong settlement target',12:'settlement value forbidden',13:'wrong settlement length',14:'wrong settlement data'};
    return `BadIntentShape(${code}): ${names[code] || 'unauthorized fill shape'}`;
  }
  if (lower.includes('badintentsignature') || lower.includes('0x4fe5b741')) return 'BadIntentSignature: owner signature does not match the intent digest.';
  if (lower.includes('max_verify_gas') || lower.includes('verify gas') || lower.includes('verification gas')) return 'MAX_VERIFY_GAS: combined VERIFY limits and signature overhead exceed 100,000 gas.';
  if (lower.includes('unstaked') || lower.includes('not staked') || lower.includes('stake')) return 'Unstaked account or paymaster: stake more than 0.01 ETH in the ERC-8421 registry.';
  return raw;
}

/** Bind the SDK to the chain 1337 deployment and an optional RPC URL. */
/** The bound Kabuto client API. */
export interface KabutoClient {
  /** Bound deployment addresses and pool configuration. */
  deployment: Deployment;
  /** Read-only viem client for the bound devnet. */
  publicClient: PublicClient;
  /** Call a gateway JSON-RPC method, including skandha methods. */
  rpc<T=any>(method:string,params?:unknown[]):Promise<T>;
  /** Deploy an account from a funded legacy EOA. */
  deployAccount(args:{funderKey:Hex;owner:Address;value?:bigint}):Promise<{address:Address;hash:Hex}>;
  /** Stake an account through the ERC-8421 registry. */
  stakeAccount(args:{account:Address;signer:KabutoSigner;value:bigint;unstakeDelaySec?:number;maxFeePerGas?:bigint;tip?:bigint}):Promise<Tracker>;
  /** Quote exact input through the v4 Quoter. */
  quote(args:{zeroForOne?:boolean;side?:QuoteSide;amountIn:bigint}):Promise<{amountOut:bigint;gasEstimate:bigint}>;
  /** Read StateView slot0 sqrt price and tick. */
  poolPrice():Promise<{sqrtPriceX96:bigint;tick:number}>;
  /** Submit a price-pinned swap. */
  protectedSwap(args:{account:Address;signer:KabutoSigner;zeroForOne:boolean;amountIn:bigint;bandBps:number|{min:bigint;max:bigint};minOut?:bigint}):Promise<Tracker>;
  /** Submit a price-pinned paymaster swap. */
  sponsoredSwap(args:{account:Address;signer:KabutoSigner;zeroForOne:boolean;amountIn:bigint;bandBps:number|{min:bigint;max:bigint};minOut?:bigint}):Promise<Tracker>;
  /** Sign an onchain intent digest without sending a transaction. */
  signIntent(args:{account:Address;signer:KabutoSigner;tokenIn:Address;maxIn:bigint;tokenOut:Address;startOut:bigint;endOut:bigint;startTime:bigint;deadline:bigint;nonce?:bigint}):Promise<SignedIntent>;
  /** Build and sign the five-frame open intent fill. */
  buildFill(args:{signedIntent:SignedIntent;filler:Address;operatorKey:Hex;amountIn:bigint;payOut:bigint;tip?:bigint;attack?:FillAttack}):Promise<FrameTx>;
  /** Submit a signed fill to the alt mempool. */
  submitFill(tx:FrameTx):Promise<Tracker>;
  /** Watch lifecycle events as an async iterable or callback. */
  track(hash:Hex,callback?:(event:Lifecycle)=>void):Tracker;
}
const TERMINAL=new Set<Lifecycle['status']>(['onchain','cancelled','reverted','replaced','rejected']);
/**
 * Map a `skandha_explorer_getTransaction` result (or a `skandha_frameTransactionStatus` result) to a lifecycle status.
 * The mempool drops `entry` once a tx is cancelled or replaced, so the event history and admission outcome decide then:
 * an `included` event wins (OnChain/Reverted), then `dropped` (Cancelled), then a `replaced` outcome, then `rejected`.
 */
export function lifecycleStatus(x:any):Lifecycle['status'] {
  const entry=x?.entry; const raw=String(entry?.status??(x&&!('entry' in x)?x.status:'')??'').toLowerCase();
  if(raw==='onchain')return 'onchain'; if(raw==='reverted')return 'reverted'; if(raw==='cancelled')return 'cancelled';
  const events:any[]=Array.isArray(x?.events)?x.events:[];
  const included=[...events].reverse().find(e=>e?.kind==='included');
  if(included)return String(included.status).toLowerCase()==='reverted'?'reverted':'onchain';
  if(events.some(e=>e?.kind==='dropped'))return 'cancelled';
  const outcome=String(x?.admission?.outcome??'').toLowerCase();
  if(outcome==='included')return 'onchain';
  if(outcome==='dropped')return 'cancelled';
  if(outcome==='replaced'||events.some(e=>e?.kind==='replaced'))return 'replaced';
  if(outcome==='rejected')return 'rejected';
  return 'pending';
}
function createKabutoImpl({rpcUrl=devnet1337.gateway,deployment=devnet1337}: {rpcUrl?:string;deployment?:Deployment} = {}): KabutoClient {
  if (deployment.chainId !== 1337) throw new Error('Kabuto SDK supports devnet chain 1337 only');
  const chain=defineChain({...kabutoChain,rpcUrls:{default:{http:[rpcUrl]}}});
  const pub=createPublicClient({chain,transport:http(rpcUrl)});
  const rpc=async <T=any>(method:string,params:unknown[]=[])=>{
    const response=await fetch(rpcUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:Date.now(),method,params},(_k,v)=>typeof v==='bigint'?`0x${v.toString(16)}`:v)});
    if(!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
    const body=await response.json() as {result:T;error?:{message:string;code:number;data?:unknown}};
    if(body.error) throw new Error(`${method} (${body.error.code}): ${body.error.message} ${JSON.stringify(body.error.data??'')}`);
    return body.result;
  };
  const send=async(tx:FrameTx)=>rpc<Hex>('eth_sendFrameTransaction',[toWire(tx)]);
  const verify=(data:Hex,execution:bigint,scope:'EXECUTION'|'EXECUTION_AND_PAYMENT'='EXECUTION_AND_PAYMENT')=>frame(profile,'VERIFY',{scope,target:null,execution,data});
  const sender=(target:Address|null,data:Hex,execution=120_000n,state=200_000n,atomic=false,value=0n)=>frame(profile,'SENDER',{target,data,execution,state,flags:atomic?4:0,value});
  async function ownerTx(account:Address,signer:KabutoSigner,frames:ReturnType<typeof frame>[],fees:{maxFeePerGas?:bigint;tip?:bigint}={}) {
    const nonce=BigInt(await pub.getTransactionCount({address:account}));
    let tx=newTx({chainId:1337,sender:account,nonceSeq:nonce,frames,signatures:[{scheme:signer.scheme==='p256'?profile.sigSchemes.P256:profile.sigSchemes.SECP256K1,signer:signer.address,msg:'0x' as Hex,signature:'0x' as Hex}],fees:{maxFeePerGas:fees.maxFeePerGas??2_000_000_000n,maxPriorityFeePerGas:fees.tip}});
    const signature=await signer.signHash(sigHash(profile,tx));
    tx={...tx,signatures:[{...tx.signatures[0],signature}]};
    return tx;
  }
  const poolKey=deployment.poolKey as {currency0:Address;currency1:Address;fee:number;tickSpacing:number;hooks:Address};
  const poolId=deployment.poolId as Hex;
  const token=(zfo:boolean)=>({tokenIn:zfo?poolKey.currency0:poolKey.currency1,tokenOut:zfo?poolKey.currency1:poolKey.currency0});
  const band=async(bps:number|{min:bigint;max:bigint})=>{
    if(typeof bps!=='number') return bps;
    if(!Number.isFinite(bps)||bps<0) throw new Error('bandBps must be nonnegative');
    const p=await poolPrice(); const d=p.sqrtPriceX96*BigInt(Math.ceil(bps/2))/10_000n;
    return {min:p.sqrtPriceX96-d,max:p.sqrtPriceX96+d};
  };
  /** Deploy a new KabutoAccount from a funded legacy EOA. */
  async function deployAccount({funderKey,owner,value=0n}:{funderKey:Hex;owner:Address;value?:bigint}) {
    const wallet=createWalletClient({account:privateKeyToAccount(funderKey),chain,transport:http(rpcUrl)});
    const data=encodeDeployData({abi:accountAbi,bytecode:accountArtifact.bytecode as Hex,args:[owner,deployment.predeploys.poolManager]});
    const gas=await pub.estimateGas({account:wallet.account,data,value});
    const hash=await wallet.sendTransaction({data,value,gas:gas*2n,gasPrice:2_000_000n,type:'legacy'} as any);
    const receipt=await pub.waitForTransactionReceipt({hash,timeout:180_000});
    if(receipt.status!=='success'||!receipt.contractAddress) throw new Error(`KabutoAccount deployment reverted: ${hash}`);
    return {address:receipt.contractAddress,hash};
  }
  /** Stake a KabutoAccount through its own frame transaction. */
  async function stakeAccount({account,signer,value,unstakeDelaySec=86400,maxFeePerGas,tip}:{account:Address;signer:KabutoSigner;value:bigint;unstakeDelaySec?:number;maxFeePerGas?:bigint;tip?:bigint}) {
    if(value<=10_000_000_000_000_000n) throw new Error('Stake must exceed 0.01 ETH');
    const tx=await ownerTx(account,signer,[verify(encodeFunctionData({abi:accountAbi,functionName:'verify'}),80_000n),sender(deployment.predeploys.stakingRegistry as Address,encodeFunctionData({abi:stakeAbi,functionName:'addStake',args:[unstakeDelaySec]}),120_000n,300_000n,false,value)],{maxFeePerGas,tip});
    const hash=await send(tx); return makeTracker(hash);
  }
  /** Quote an exact input swap through the live Uniswap v4 Quoter. */
  async function quote({zeroForOne,side,amountIn}:{zeroForOne?:boolean;side?:QuoteSide;amountIn:bigint}) {
    if(zeroForOne===undefined && side===undefined) throw new Error('quote requires side or zeroForOne');
    const z=zeroForOne??(side==='buy'?!deployment.wethIs0:side==='sell'?deployment.wethIs0:side==='zeroForOne');
    const {result}=await pub.simulateContract({address:'0xeEa49CC6419125E2f706bf7f95Cf34ac7e93087D',abi:quoteAbi,functionName:'quoteExactInputSingle',args:[{poolKey,zeroForOne:z,exactAmount:amountIn,hookData:'0x'}]});
    return {amountOut:result[0],gasEstimate:result[1]};
  }
  /** Read the current pool sqrt price and tick from StateView. */
  async function poolPrice() {
    const [sqrtPriceX96,tick]=await pub.readContract({address:deployment.predeploys.stateView as Address,abi:slotAbi,functionName:'getSlot0',args:[poolId]});
    return {sqrtPriceX96,tick};
  }
  /** Send a price pinned swap; admission rejects a moved price before gas is charged. */
  async function protectedSwap({account,signer,zeroForOne,amountIn,bandBps,minOut=0n}:{account:Address;signer:KabutoSigner;zeroForOne:boolean;amountIn:bigint;bandBps:number|{min:bigint;max:bigint};minOut?:bigint}) {
    const b=await band(bandBps), t=token(zeroForOne);
    const tx=await ownerTx(account,signer,[verify(encodeFunctionData({abi:accountAbi,functionName:'verifyPrice',args:[poolId,b.min,b.max]}),90_000n),sender(t.tokenIn,encodeFunctionData({abi:erc20Abi,functionName:'approve',args:[deployment.router as Address,amountIn]}),120_000n,200_000n,true),sender(deployment.router as Address,encodeFunctionData({abi:routerAbi,functionName:'swapExactIn',args:[poolKey,zeroForOne,amountIn,minOut,account]}),400_000n,200_000n)]);
    return makeTracker(await send(tx));
  }
  /** Send the proven paymaster swap shape; the paymaster takes its fee in output token. */
  async function sponsoredSwap({account,signer,zeroForOne,amountIn,bandBps,minOut=0n}:{account:Address;signer:KabutoSigner;zeroForOne:boolean;amountIn:bigint;bandBps:number|{min:bigint;max:bigint};minOut?:bigint}) {
    const b=await band(bandBps),t=token(zeroForOne),fee=BigInt(t.tokenOut.toLowerCase()===deployment.kusd.toLowerCase()?deployment.paymasterFees.kUSD:deployment.paymasterFees.WETH);
    const tx=await ownerTx(account,signer,[verify(encodeFunctionData({abi:accountAbi,functionName:'verifyPriceExecution',args:[poolId,b.min,b.max]}),35_000n,'EXECUTION'),frame(profile,'VERIFY',{scope:'PAYMENT',target:deployment.paymaster as Address,execution:60_000n,data:encodeFunctionData({abi:paymasterAbi,functionName:'sponsor',args:[b.min,b.max]})}),sender(t.tokenIn,encodeFunctionData({abi:erc20Abi,functionName:'approve',args:[deployment.router as Address,amountIn]}),120_000n,200_000n,true),sender(deployment.router as Address,encodeFunctionData({abi:routerAbi,functionName:'swapExactIn',args:[poolKey,zeroForOne,amountIn,minOut,account]}),400_000n,200_000n,true),sender(t.tokenOut,encodeFunctionData({abi:erc20Abi,functionName:'transfer',args:[deployment.paymaster as Address,fee]}),120_000n)]);
    return makeTracker(await send(tx));
  }
  /** Sign an open intent digest only; this performs no transaction and spends no gas. */
  async function signIntent({account,signer,tokenIn,maxIn,tokenOut,startOut,endOut,startTime,deadline,nonce}:{account:Address;signer:KabutoSigner;tokenIn:Address;maxIn:bigint;tokenOut:Address;startOut:bigint;endOut:bigint;startTime:bigint;deadline:bigint;nonce?:bigint}):Promise<SignedIntent> {
    const i={tokenIn,maxIn,tokenOut,startOut,endOut,startTime,deadline,nonce:nonce??BigInt(await pub.getTransactionCount({address:account}))};
    const digest=await pub.readContract({address:account,abi:accountAbi,functionName:'intentDigest',args:[i]}) as Hex;
    return {intent:i,digest,signature:await signer.signHash(digest),account,owner:signer.address,scheme:signer.scheme};
  }
  /** Build the signed five frame fill, with optional tampering for devnet security demos. */
  async function buildFill({signedIntent,filler,operatorKey,amountIn,payOut,tip=100_000_000n,attack}:{signedIntent:SignedIntent;filler:Address;operatorKey:Hex;amountIn:bigint;payOut:bigint;tip?:bigint;attack?:FillAttack}):Promise<FrameTx> {
    const {intent:i,account,owner,digest,signature,scheme}=signedIntent;
    const zfo=i.tokenIn.toLowerCase()===poolKey.currency0.toLowerCase();
    const before=await pub.readContract({address:i.tokenOut,abi:erc20Abi,functionName:'balanceOf',args:[account]});
    const operator=privateKeyToAccount(operatorKey).address;
    const frames=[verify(encodeFunctionData({abi:accountAbi,functionName:'verifyIntent',args:[i]}),intentVerifyBudget(scheme),'EXECUTION'),frame(profile,'VERIFY',{scope:'PAYMENT',target:filler,execution:12_000n,data:encodeFunctionData({abi:fillerAbi,functionName:'pay'})}),sender(i.tokenIn,encodeFunctionData({abi:erc20Abi,functionName:'transfer',args:[filler,attack==='over-max'?i.maxIn+1n:amountIn]}),80_000n,100_000n,attack!=='no-atomic'),...(attack==='extra-sender'?[sender(i.tokenIn,encodeFunctionData({abi:erc20Abi,functionName:'transfer',args:[operator,1n]}),80_000n,100_000n,true)]:[]),frame(profile,'DEFAULT',{target:filler,execution:400_000n,state:200_000n,flags:4,data:encodeFunctionData({abi:fillerAbi,functionName:'fill',args:[poolKey,zfo,amountIn,account,attack==='underpay'?i.endOut/2n:payOut]})}),sender(null,encodeFunctionData({abi:accountAbi,functionName:'settleIntent',args:[i.tokenOut,before,i.startOut,i.endOut,i.startTime,i.deadline]}),80_000n)];
    let tx=newTx({chainId:1337,sender:account,nonceSeq:i.nonce,frames,signatures:[{scheme:scheme==='p256'?profile.sigSchemes.P256:profile.sigSchemes.SECP256K1,signer:owner,msg:digest,signature},{scheme:profile.sigSchemes.SECP256K1,signer:operator,msg:'0x' as Hex,signature:'0x' as Hex}],fees:{maxFeePerGas:tip*2n>2_000_000_000n?tip*2n:2_000_000_000n,maxPriorityFeePerGas:tip}});
    return signTx(profile,tx,operatorKey,1);
  }
  /** Submit a signed fill to the devnet alt mempool. */
  async function submitFill(tx:FrameTx) {return makeTracker(await send(tx));}
  /** Observe admission and chain lifecycle; accepts an optional event callback. */
  function track(hash:Hex,callback?: (event:Lifecycle)=>void) {const tracker=makeTracker(hash,callback);if(callback)void (async()=>{for await(const _ of tracker.events()){} })().catch(e=>console.error('Kabuto tracking failed',e));return tracker;}
  function makeTracker(hash:Hex,callback?: (event:Lifecycle)=>void):Tracker {
    const events=async function* (cb?: (event:Lifecycle)=>void):AsyncGenerator<Lifecycle> {
      let last=''; const started=Date.now();
      const admitted:Lifecycle={status:'admitted',hash}; callback?.(admitted); cb?.(admitted); yield admitted;
      while(Date.now()-started<180_000) {
        let x:any;
        try {x=await rpc('skandha_explorer_getTransaction',[hash]);} catch {x=await rpc('skandha_frameTransactionStatus',[hash]);}
        const status=lifecycleStatus(x);
        if(status!==last){
          const receipt=status==='onchain'||status==='reverted'?await rpc<any>('eth_getTransactionReceipt',[hash]).catch(()=>null):null;
          const e:Lifecycle={status,hash,admission:x?.admission,block:receipt?.blockNumber?BigInt(receipt.blockNumber):undefined,index:receipt?.transactionIndex?Number(BigInt(receipt.transactionIndex)):undefined,frames:receipt?.frameReceipts??x?.admission?.frameStatuses};
          callback?.(e);cb?.(e);yield e;last=status;
        }
        if(TERMINAL.has(status)) return;
        await sleep(1500);
      }
      throw new Error(`Transaction ${hash} was not resolved within 180 s`);
    };
    return {hash,events,[Symbol.asyncIterator]:()=>events(),async wait(){let last:Lifecycle|undefined;for await(const e of events())last=e;return last!;}};
  }
  return {deployment,publicClient:pub,rpc,deployAccount,stakeAccount,quote,poolPrice,protectedSwap,sponsoredSwap,signIntent,buildFill,submitFill,track};
}

/** Bind the SDK to the chain 1337 deployment and an optional RPC URL. */
export function createKabuto(args: {rpcUrl?:string;deployment?:Deployment} = {}): KabutoClient { return createKabutoImpl(args); }
