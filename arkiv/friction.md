# Arkiv friction

The public Rabdi RPC works for a raw query but warns that it is heavily rate limited; an access key requires a hub registration and CAPTCHA. Funding a new writer also requires a human faucet claim with CAPTCHA, so the live write case remains unverified in this checkout. The SDK requires `rabdi({ accessKey: "" })` even for the public endpoint; omitting the field throws. A query page is limited to 100 rows, so readers must paginate to show recent fills reliably.

One API detail caught during implementation: `$createdAt` can be returned in query results but cannot be used as an Arkiv sort key. The browser fetches fill pages and sorts their timestamps locally. The browser bundle built with SDK 1.0.1, with no Node-only import error.
