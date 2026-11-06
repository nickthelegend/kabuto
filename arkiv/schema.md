# Kabuto Arkiv schema

Network: Rabdi, chain 7794095. Settlement: EIP-8141 devnet, chain 1337.

`kabuto.intent.v1` has indexed `account`, `tokenIn`, `tokenOut` (`addr`), `status` (`str`: open, filled, refused, cancelled), `deadline` (`u64`, Unix seconds), and `chainId` (`u64`, 1337). Its `intent` field is unindexed `bytes` containing the full signed intent JSON with big integers as decimal strings. The relay writer owns each entity. `ExpirationTime.atDate(deadline)` makes the listing expire at its signed deadline.

`kabuto.fill.v1` has indexed `intentKey` (`key`), `filler` (`addr`), and `outcome` (`str`: landed or refused). `txHash` is an unindexed string for the chain 1337 transaction; `reason` is an optional unindexed string. The relay writer owns each fill entity. Fills expire after 30 days.

Readers filter with `.ownedBy(writer)`. A filler rechecks the signed intent against the account on chain 1337 before filling. The relay alone patches the status to `filled` after a landed report.

Queries (always add the owner filter):

```text
arkiv.schema = str('kabuto.fill.v1') AND $owner = addr(0x8eD225Ae7f4b445Bfee6ad5dd9719C59426Af3aF)
arkiv.schema = str('kabuto.intent.v1') AND status = str('open') AND chainId = u64(1337) AND $owner = addr(0x8eD225Ae7f4b445Bfee6ad5dd9719C59426Af3aF)
```

The first returns the fill log (30-day entities); the second returns rows only while an intent is open, because intent entities expire at their deadline.
