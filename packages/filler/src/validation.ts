import { recoverAddress, hexToBytes, isAddress, isHex } from 'viem';
import { p256 } from '@noble/curves/p256';
import { createKabuto, type SignedIntent } from '@kabuto/sdk';
const sdk = createKabuto();
export function decodeIntent(x:any):SignedIntent {return {...x,intent:{...x.intent,maxIn:BigInt(x.intent.maxIn),startOut:BigInt(x.intent.startOut),endOut:BigInt(x.intent.endOut),startTime:BigInt(x.intent.startTime),deadline:BigInt(x.intent.deadline),nonce:BigInt(x.intent.nonce)}};}
export async function validate(x:any):Promise<SignedIntent> {
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
