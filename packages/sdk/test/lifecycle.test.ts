import { describe, expect, it } from 'vitest';
import { lifecycleStatus } from '../src/index';

// Shapes follow the sidecar's documented `skandha_explorer_getTransaction` result (docs/sidecar_explorer.md):
// `entry` is null once the mempool no longer holds the tx; `events` holds the retained lifecycle history.
describe('lifecycleStatus', () => {
  it('reads a live entry', () => {
    expect(lifecycleStatus({ entry: { status: 'OnChain' }, events: [] })).toBe('onchain');
    expect(lifecycleStatus({ entry: { status: 'New' }, events: [{ kind: 'admitted', status: 'New' }] })).toBe('pending');
  });
  it('reports a front-run protected swap as cancelled once the entry is gone (audit R8: dropped, then replaced)', () => {
    const x = { entry: null, admission: { outcome: 'replaced' }, events: [{ kind: 'admitted', status: 'New' }, { kind: 'dropped', status: 'Cancelled' }, { kind: 'replaced' }] };
    expect(lifecycleStatus(x)).toBe('cancelled');
  });
  it('lets a later inclusion win over an earlier drop', () => {
    expect(lifecycleStatus({ entry: null, admission: { outcome: 'included' }, events: [{ kind: 'dropped', status: 'Cancelled' }, { kind: 'included', status: 'Reverted' }] })).toBe('reverted');
  });
  it('separates a plain nonce replacement and an admission rejection', () => {
    expect(lifecycleStatus({ entry: null, admission: { outcome: 'replaced' }, events: [{ kind: 'admitted' }] })).toBe('replaced');
    expect(lifecycleStatus({ entry: null, admission: { outcome: 'rejected' }, events: [] })).toBe('rejected');
  });
  it('still accepts the skandha_frameTransactionStatus shape', () => {
    expect(lifecycleStatus({ status: 'Cancelled' })).toBe('cancelled');
  });
});
