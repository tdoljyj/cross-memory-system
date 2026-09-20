package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"time"
)

type commitState string

const (
	notCommitted  commitState = "NOT_COMMITTED"
	committed     commitState = "COMMITTED"
	commitUnknown commitState = "UNKNOWN_PRESERVE_FORENSICS"
)

type publicationError struct {
	state commitState
	cause error
}

func (e *publicationError) Error() string {
	return fmt.Sprintf("CURRENT_PUBLICATION_%s: %v", e.state, e.cause)
}
func (e *publicationError) Unwrap() error { return e.cause }
func committedPublication(err error) bool {
	var p *publicationError
	return errors.As(err, &p) && p.state == committed
}

type boundedDeadlineReader struct {
	reader   io.Reader
	now      func() time.Time
	deadline time.Time
}

func (r *boundedDeadlineReader) Read(b []byte) (int, error) {
	if !r.now().Before(r.deadline) {
		return 0, fail("MAX_WALL_TIME_EXCEEDED")
	}
	return r.reader.Read(b)
}

// This never grants a new start or extends the issued lifetime. After expiry,
// only original owned-handle termination and forensic reporting are permitted.
func (c *controller) safetyPortReleased() error {
	end := time.Now().Add(2 * time.Second)
	for {
		if c.sys.portFree() {
			return nil
		}
		if !time.Now().Before(end) {
			return fail("PORT_NOT_RELEASED_AFTER_FAILURE_CLEANUP")
		}
		time.Sleep(20 * time.Millisecond)
	}
}
func pathState(path string) string {
	_, e := os.Lstat(path)
	if e == nil {
		return "PRESENT"
	}
	if os.IsNotExist(e) {
		return "ABSENT"
	}
	return "UNKNOWN: " + e.Error()
}
func (c *controller) finalizeFailure(ctx *executionContext, cause error) error {
	if e := c.requireContext(ctx); e != nil {
		return errors.Join(cause, e)
	}
	cleanup := c.cleanupProcesses(ctx)
	port := c.safetyPortReleased()
	var liveErr error
	for _, r := range c.processes {
		if r.ctx != ctx || r.closed {
			continue
		}
		alive, e := r.proc.alive()
		liveErr = errors.Join(liveErr, e)
		if alive {
			liveErr = errors.Join(liveErr, fail("OWNED_PROCESS_REMAINS_AFTER_FAILURE"))
		}
	}
	outcome := errors.Join(cause, cleanup, port, liveErr)
	ev := c.writeEvidence(ctx, "M1RuntimeLifecycleFailure.json", object{
		"profile_id": issuedID, "pass": false, "failure": outcome.Error(),
		"owned_process_cleanup_verified": cleanup == nil && liveErr == nil,
		"port_18088_free":                port == nil, "runtime_root_state": pathState(c.paths.testRoot),
		"guard_state": pathState(c.paths.guard), "evidence_state": pathState(c.paths.evidence),
		"forensic_retention": true, "business_authority_extended": false,
	}, false)
	if ev != nil {
		return errors.Join(outcome, fmt.Errorf("failure evidence not persisted: %w", ev))
	}
	return outcome
}
func (c *controller) recoverInitialFailure(ctx *executionContext, cause error) error {
	if e := c.cleanupProcesses(ctx); e != nil {
		return errors.Join(cause, e)
	}
	if e := c.safetyPortReleased(); e != nil {
		return errors.Join(cause, e)
	}
	re := c.removeUnverifiedInitialCurrent(ctx)
	status := "REMOVED_EXACT_UNVERIFIED_A"
	if re != nil {
		status = "FAILED_CLOSED_FORENSICS_RETAINED"
	}
	ev := c.writeEvidence(ctx, "M1RuntimeLifecycleInstall.json", object{"profile_id": issuedID, "pass": false, "failure": cause.Error(), "conditional_current_removal": status}, false)
	return c.terminalFailure(ctx, "M1-08-PC-INSTALL-001", errors.Join(cause, re, ev), object{"conditional_current_removal": status, "runtime_root_retained": true})
}

// Publication errors carry the native commit result. A function-level error is
// never interpreted as proof that no activation occurred.
func (c *controller) activateAndProbe(ctx *executionContext, spec transitionSpec, scenario, label string) error {
	_, err := c.publishCurrent(ctx, spec)
	if err != nil && !committedPublication(err) {
		return err
	}
	if err == nil {
		err = c.probeActiveSlot(ctx, spec.to, scenario, label)
	}
	if err == nil {
		return nil
	}
	switch spec.index {
	case 1:
		return c.recoverInitialFailure(ctx, err)
	case 2:
		return c.recoverUpgradeFailure(ctx, err)
	case 3:
		return c.recoverRollbackFailure(ctx, err)
	}
	return err
}
