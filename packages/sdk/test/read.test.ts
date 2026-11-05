import {describe,expect,it} from 'vitest';
import {createKabuto,devnet1337,p256Signer,secp256k1Signer} from '../src/index.js';
import {generatePrivateKey} from 'viem/accounts';
import {hexToBytes,recoverAddress} from 'viem';
import {p256} from '@noble/curves/p256';

const sdk=createKabuto();
describe('SDK reads and signatures',()=>{
  it('quotes the live v4 pool and reads its StateView price',async()=>{
    const price=await sdk.poolPrice();expect(price.sqrtPriceX96).toBeGreaterThan(0n);
    const quote=await sdk.quote({zeroForOne:!devnet1337.wethIs0,amountIn:10_000_000n});expect(quote.amountOut).toBeGreaterThan(0n);
  });
  it('packs valid secp256k1 and P256 signatures',async()=>{
    const hash=`0x${'12'.repeat(32)}` as const;
    const k=secp256k1Signer(generatePrivateKey()),sig=await k.signHash(hash);
    const recovered=await recoverAddress({hash,signature:{r:`0x${sig.slice(4,68)}`,s:`0x${sig.slice(68,132)}`,yParity:Number.parseInt(sig.slice(2,4),16)} as any});
    expect(recovered.toLowerCase()).toBe(k.address.toLowerCase());
    const p=p256Signer(generatePrivateKey()),packed=hexToBytes(await p.signHash(hash));
    expect(p256.verify(packed.slice(0,64),hexToBytes(hash),new Uint8Array([4,...packed.slice(64)]),{lowS:true,prehash:false})).toBe(true);
  });

});
