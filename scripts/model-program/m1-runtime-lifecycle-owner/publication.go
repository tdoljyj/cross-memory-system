package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
)

type publicationState string

const (
	publicationNotCommitted publicationState = "NOT_COMMITTED"
	publicationCommitted    publicationState = "COMMITTED"
	publicationUnknown      publicationState = "UNKNOWN"
)

type publicationFailure struct {
	state    publicationState
	cause    error
	expected []byte
}

func (e *publicationFailure) Error() string {
	return fmt.Sprintf("CURRENT_PUBLICATION_%s: %v", e.state, e.cause)
}
func (e *publicationFailure) Unwrap() error { return e.cause }

func (c *controller) observePublication(oldRaw, newRaw []byte, initial bool) (publicationState, object, []byte, error) {
	m, raw, e := c.readCurrent()
	if e != nil {
		if initial && os.IsNotExist(e) {
			return publicationNotCommitted, nil, nil, nil
		}
		return publicationUnknown, nil, nil, e
	}
	if bytes.Equal(raw, newRaw) {
		return publicationCommitted, m, raw, nil
	}
	if !initial && bytes.Equal(raw, oldRaw) {
		return publicationNotCommitted, m, raw, nil
	}
	return publicationUnknown, m, raw, fail("CURRENT_MANIFEST_ATOMICITY_UNPROVEN")
}
func (c *controller) handlePublicationFailure(ctx *executionContext, spec transitionSpec, cause error) error {
	var pe *publicationFailure
	if !errors.As(cause, &pe) {
		return c.terminalFailure(ctx, "LIFECYCLE", cause, object{"publication_state": string(publicationNotCommitted)})
	}
	state := pe.state
	if state == publicationUnknown {
		m, raw, e := c.readCurrent()
		if e == nil && bytes.Equal(raw, pe.expected) && transitionMatches(m, spec) {
			// Only identity-verified, exact bytes can resolve an uncertain commit.
			state = publicationCommitted
			c.currentBytes = append([]byte(nil), raw...)
			c.currentSpec = spec
		}
	}
	if state != publicationCommitted {
		return c.terminalFailure(ctx, "LIFECYCLE", cause, object{"publication_state": string(state), "runtime_preserved": true})
	}
	switch spec.index {
	case 1:
		return c.recoverInstallFailure(ctx, cause)
	case 2:
		return c.recoverUpgradeFailure(ctx, cause)
	case 3:
		return c.recoverRollbackFailure(ctx, cause)
	default:
		return errors.Join(cause, fail("UNAUTHORIZED_RECOVERY_TRANSITION"))
	}
}
func (c *controller) recoverInstallFailure(ctx *executionContext, cause error) error {
	if e := c.cleanupProcesses(ctx); e != nil {
		return errors.Join(cause, e)
	}
	if !c.sys.portFree() {
		return errors.Join(cause, fail("LISTENER_REMAINS_AFTER_OWNED_PROCESS_CLEANUP"))
	}
	e := c.removeUnverifiedInitialCurrent(ctx)
	status := "REMOVED_EXACT_UNVERIFIED_A"
	if e != nil {
		status = "FAILED_CLOSED_FORENSIC_STATE_RETAINED"
	}
	ev := c.writeEvidence(ctx, "M1RuntimeLifecycleInstall.json", object{
		"profile_id": issuedID, "pass": false, "failure_code": codeOf(cause),
		"conditional_current_removal": status, "removal_failure": fmt.Sprint(e),
	}, false)
	return c.terminalFailure(ctx, "M1-08-PC-INSTALL-001", errors.Join(cause, e, ev), object{"recovery": status, "runtime_root_retained": true})
}
