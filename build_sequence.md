# Build Sequence — Vibemail Engine

Atomic build order. Each unit must pass its verify step before starting the next.

---

## 1. Provider abstraction interface
**Verify:** TypeScript compiles clean, and the interface defines all required methods.

## 2. Gmail OAuth layer with token persistence listener
**Verify:** OAuth flow completes, tokens store in Supabase, refresh works without a token mismatch.

## 3. Sync and read layer
**Verify:** Initial sync fetches 50 messages and objects match the contract model.

## 4. Pub/sub webhook receiver
**Verify:** A notification fetches the correct delta through history ID.

## 5. Send layer
**Verify:** A message sends successfully through Gmail for an authenticated user.

## 6. Vercel API function entry points
**Verify:** All four endpoints respond correctly in local preview.

## 7. Integration tests
**Verify:** The full suite passes with no skipped tests against live Supabase.
