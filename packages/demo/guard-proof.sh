#!/usr/bin/env bash
# KabutoGuard live proof for the film: read-only calls to the public chain 1337 gateway. No keys.
# Every command is printed exactly as it runs.   record2.mjs guard serves this through ttyd on :3100.
export R=https://altmempool.forshtat.com
export PINNED=0xd1962486165f1c4afdf3aec80ad6f2c6f882063403ad81e8469165e68472f861   # frame tx, price pinned in VERIFY
export PLAIN=0x8fd351e2cffefc53e3680916bdb4007f24cbbc9b601ae37b13a80287e3291829    # legacy tx, same router + pool
export FROM=0x41f2A696df19686b84BaA0807F7d91F3F164Eb61 ROUTER=0x96CDb816A8BE85b238Ceb3F53A7334B7f74359bE
run() { printf '\n\033[38;5;222m$\033[0m %s\n' "$1"; sleep 0.7; eval "$1"; sleep "${2:-1.4}"; }
clear; sleep 1
printf '\033[1mKabutoGuard v4 pool · hook 0x9A48…0080 · chain 1337\033[0m\n'
printf '\033[2mPINNED=%s\nPLAIN=%s\033[0m\n' "$PINNED" "$PLAIN"
run "cast receipt \$PINNED --rpc-url \$R | grep -E '^(type|status) '"
run "cast receipt \$PLAIN --rpc-url \$R | grep -E '^(type|status) '"
run "cast call \$ROUTER \$(cast tx \$PLAIN input --rpc-url \$R) --from \$FROM --rpc-url \$R 2>&1 | grep -o '0x90bfb865[0-9a-f]*' | fold -w 64"
run "cast sig 'NotFrameTx()'" 8
