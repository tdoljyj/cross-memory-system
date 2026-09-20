package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
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

// No new execution authority is created by finalization. A consumed context
// retains only the ability to close its own child handles and record failure.
func (c *controller) finalizeAttempt(ctx *executionContext, cause error) (finalErr error) {
	if e := c.requireContext(ctx); e != nil {
		return errors.Join(cause, e)
	}
	if prior, done := c.finalized[ctx]; done {
		return errors.Join(cause, prior)
	}
	defer func() { c.finalized[ctx] = finalErr }()
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
	_, guardErr := os.Lstat(c.paths.guard)
	_, rootErr := os.Lstat(c.paths.testRoot)
	remaining := c.remainingOwnedState()
	// Failure evidence uses the already-authorized append-only Events stream.
	// It is the only post-expiry write capability and records the exact creation
	// ledger still owned by this attempt, including live pathname observations.
	evidenceErr := c.writeTerminalEvidence(ctx, object{
		"profile_id": issuedID, "scenario": "FINALIZATION", "kind": "terminal_failure",
		"pass": false, "failure": fmt.Sprint(result), "cleanup_failure": fmt.Sprint(cleanup),
		"port_18088_free": free,
		"guard_exists":    guardErr == nil, "guard_state_error": fmt.Sprint(guardErr),
		"runtime_root_exists": rootErr == nil, "runtime_root_state_error": fmt.Sprint(rootErr),
		"runtime_root_preserved_for_forensics": rootErr == nil,
		"remaining_test_owned_state": remaining,
		"current_bytes_sha256": map[bool]string{true: sha(c.currentBytes), false: ""}[len(c.currentBytes) != 0],
		"ts_utc": c.now().UTC().Format(time.RFC3339Nano),
	})
	if evidenceErr != nil {
		result = errors.Join(result, fmt.Errorf("TERMINAL_EVIDENCE_UNAVAILABLE: %w", evidenceErr))
	}
	return result
}

func (c *controller) remainingOwnedState() []any {
	keys := make([]string, 0, len(c.created))
	for path := range c.created {
		keys = append(keys, path)
	}
	sort.Strings(keys)
	rows := make([]any, 0, len(keys))
	for _, path := range keys {
		row := object{"path": path, "creation_identity": c.created[path]}
		st, err := os.Lstat(path)
		if err == nil {
			row["exists"] = true
			row["is_dir"] = st.IsDir()
			row["size"] = json.Number(strconvFormatInt(st.Size()))
			row["mode"] = st.Mode().String()
			if final, fe := c.sys.finalPath(path); fe == nil {
				row["final_path"] = final
			} else {
				row["final_path_error"] = fe.Error()
			}
		} else {
			row["exists"] = false
			row["state_error"] = err.Error()
		}
		rows = append(rows, row)
	}
	return rows
}
