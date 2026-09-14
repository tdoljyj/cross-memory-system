# Root9 post-budget CAS unknown-response protocol

Status: `MANDATORY / READBACK ONLY / FAIL CLOSED`

1. Preserve the exact submitted SQL bytes and raw connector response.
2. On timeout, disconnect, truncation, empty response, or any ambiguous result, do not resubmit.
3. Run the sealed `readback_readonly.sql`.
4. Classify:
   - `PASS_EXACT_ROOT9_SEQ104_PENDING102_INHERITED`: committed; stop.
   - exact original preimage `PASS_EXACT_ROOT9_SEQ102_PENDING`: rolled back; a retry is permitted
     only after independent confirmation that the same sealed SQL still matches all publication,
     catalog, ACL and prefix pins.
   - anything else: `UNKNOWN_CONFLICT`; stop.

A successful submission changes the Gate function preimage, so the original CAS is intentionally not
a replay probe and a second direct submission fails closed before its duplicate branch. Extra
sequence 105, Status28, partial Status27/103/104, catalog drift, budget drift, refund, allocation or
charged-total drift are conflicts, never reasons for a blind retry.
