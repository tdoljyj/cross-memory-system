package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

func earlierDeadline(a, b time.Time) time.Time {
	if b.Before(a) {
		return b
	}
	return a
}
func checkDeadline(now, deadline, expiry time.Time) error {
	if !expiry.IsZero() && !now.Before(expiry) {
		return fail("PROFILE_EXPIRED_OR_REVOKED")
	}
	if !now.Before(deadline) {
		return fail("MAX_WALL_TIME_EXCEEDED")
	}
	return nil
}

// Only this stack frame enables terminal evidence. It does not issue a reusable
// post-expiry capability, accept an output name, or resurrect lifecycle authority.
func (c *controller) finalizeAttempt(ctx *executionContext, cause error) (finalErr error) {
	if e := c.requireContext(ctx); e != nil {
		return errors.Join(cause, e)
	}
	if prior, done := c.finalized[ctx]; done {
		return errors.Join(cause, prior)
	}
	if c.finalizing[ctx] {
		return errors.Join(cause, fail("FINALIZATION_ALREADY_ACTIVE"))
	}
	c.finalizing[ctx] = true
	defer func() { delete(c.finalizing, ctx); c.finalized[ctx] = finalErr }()
	cleanup := c.cleanupProcesses(ctx)
	free := c.sys.portFree()
	if !free {
		cleanup = errors.Join(cleanup, fail("LISTENER_REMAINS_AFTER_OWNED_PROCESS_CLEANUP"))
	}
	result := errors.Join(cause, cleanup, ctx.budget.err())
	if result == nil {
		if !c.completed[ctx] {
			result = fail("LIFECYCLE_NOT_COMPLETED")
		}
		if result == nil {
			result = checkDeadline(c.now(), ctx.deadline, ctx.expires)
		}
		if result == nil {
			result = c.writeEvidence(ctx, "M1RuntimeLifecycleCloseout.json", object{
				"profile_id": issuedID, "pass": true, "server_starts": json.Number(strconvFormatInt(int64(ctx.starts))),
				"binary_version_migration_claim": false, "install": "PASS", "upgrade": "PASS", "rollback": "PASS", "cleanup": "PASS",
			}, false)
		}
		if result == nil {
			return nil
		}
	}
	// The only post-expiry writer constructs a fixed failure event itself.
	// There is no generic raw/bool bypass and no caller-supplied event payload.
	return errors.Join(result, c.writeTerminalFailure(ctx, result, cleanup, free))
}

func (c *controller) writeTerminalFailure(ctx *executionContext, cause, cleanup error, free bool) error {
	if e := c.requireContext(ctx); e != nil {
		return e
	}
	if !c.finalizing[ctx] || cause == nil {
		return fail("TERMINAL_FINALIZER_AUTHORITY_REQUIRED")
	}
	if _, done := c.finalized[ctx]; done {
		return fail("ATTEMPT_ALREADY_FINALIZED")
	}
	state, stateErr := c.remainingOwnedState(ctx)
	// These observations describe the pre-append state, not a fictitious atomic
	// snapshot or the post-append hash of the Events file being written below.
	row := object{
		"profile_id": issuedID, "scenario": "FINALIZATION", "kind": "terminal_failure", "pass": false,
		"failure": boundedDiagnostic(cause), "cleanup_failure": boundedDiagnostic(cleanup),
		"port_18088_free": free, "remaining_test_owned_state": state,
		"remaining_state_error":        boundedDiagnostic(stateErr),
		"invalidates_success_closeout": true,
		"ts_utc":                       c.now().UTC().Format(time.RFC3339Nano),
	}
	raw := append(canonical(row), '\n')
	if e := ctx.budget.consume(int64(len(raw)), false); e != nil {
		return errors.Join(stateErr, fmt.Errorf("TERMINAL_EVIDENCE_UNAVAILABLE: %w", e))
	}
	path := filepath.Join(c.paths.evidence, "M1RuntimeLifecycleEvents.jsonl")
	_, e := os.Lstat(path)
	if e == nil || os.IsNotExist(e) {
		var f *os.File
		f, e = c.openOwnedWrite(path, os.IsNotExist(e))
		if e == nil {
			e = writeSyncClose(f, raw)
		}
	}
	if e != nil {
		e = fmt.Errorf("TERMINAL_EVIDENCE_UNAVAILABLE: %w", e)
	}
	return errors.Join(stateErr, e)
}
func boundedDiagnostic(e error) string {
	if e == nil {
		return ""
	}
	s := e.Error()
	if len(s) > 4096 {
		return s[:4096] + " [DIAGNOSTIC_TRUNCATED]"
	}
	return s
}
