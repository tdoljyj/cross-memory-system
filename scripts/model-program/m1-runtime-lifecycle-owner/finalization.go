package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"time"
)

const maxTerminalEvidenceBytes = 2 << 20
const maxForensicEntries = 2048
const maxForensicInventoryBytes = 1 << 20
const terminalSafetyWindow = 30 * time.Second

// An internal safety-only state. It neither changes the signed expiry nor
// authorizes lifecycle publication, launch, recovery, directory creation or delete.
type terminalEvidenceState struct {
	deadline       time.Time
	writeAttempted bool
}

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
func (c *controller) requireTerminalEvidence(ctx *executionContext) (*terminalEvidenceState, error) {
	if e := c.requireContext(ctx); e != nil {
		return nil, e
	}
	if _, done := c.finalized[ctx]; done {
		return nil, fail("TERMINAL_EVIDENCE_AUTHORITY_CLOSED")
	}
	state := c.terminal[ctx]
	if state == nil {
		return nil, fail("TERMINAL_EVIDENCE_REQUIRES_FINALIZATION")
	}
	if !c.now().Before(state.deadline) {
		return nil, fail("TERMINAL_SAFETY_WINDOW_EXCEEDED")
	}
	return state, nil
}

func boundedFailure(e error) object {
	s := fmt.Sprint(e)
	prefix := s
	if len(prefix) > 4096 {
		prefix = prefix[:4096]
	}
	return object{"message": prefix, "truncated": len(prefix) != len(s),
		"full_message_utf8_bytes": json.Number(strconvFormatInt(int64(len(s)))), "full_message_sha256": sha([]byte(s))}
}

// All consumed attempts converge here. Only this function can enter the
// terminal-only state, after normal execution has failed. Completion is latched
// even if evidence fails; neither repeated calls nor clock changes resurrect it.
func (c *controller) finalizeAttempt(ctx *executionContext, cause error) (finalErr error) {
	if e := c.requireContext(ctx); e != nil {
		return errors.Join(cause, e)
	}
	if prior, done := c.finalized[ctx]; done {
		return errors.Join(cause, prior)
	}
	if c.terminal[ctx] != nil {
		return errors.Join(cause, fail("FINALIZATION_ALREADY_IN_PROGRESS"))
	}
	defer func() { delete(c.terminal, ctx); c.finalized[ctx] = finalErr }()
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

	// This fresh bounded safety window is NOT a new lifecycle deadline. limits()
	// rejects all normal operations once it exists. It permits read-only forensic
	// observation and one fixed failure event; no runtime or Guard mutation.
	c.terminal[ctx] = &terminalEvidenceState{deadline: c.now().Add(terminalSafetyWindow)}
	remaining, inventoryErr := c.remainingOwnedState(ctx)
	processes, processErr := c.remainingOwnedProcesses(ctx)
	result = errors.Join(result, inventoryErr, processErr)
	evidenceErr := c.writeTerminalEvidence(ctx, object{
		"profile_id": issuedID, "scenario": "FINALIZATION", "kind": "terminal_failure", "pass": false,
		"failure": boundedFailure(result), "cleanup_failure": boundedFailure(cleanup),
		"port_18088_free_at_cleanup_observation": free,
		"remaining_test_owned_state":             remaining,
		"remaining_owned_processes":              processes,
		"runtime_root_preserved_for_forensics":   true,
		"runtime_root_preserved_semantics":       "FINALIZER_PERFORMS_NO_RUNTIME_DELETE; SEE_OBSERVED_ROOT_STATE",
		"ts_utc":                                 c.now().UTC().Format(time.RFC3339Nano),
	})
	if evidenceErr != nil {
		result = errors.Join(result, fmt.Errorf("TERMINAL_EVIDENCE_UNAVAILABLE: %w", evidenceErr))
	}
	return result
}

// Enumerate bounded batches from the same pinned directory object. This helper
// never uses an unbounded pathname walk, follows a reparse point or provisions a
// directory. Identity and directory membership are checked again after traversal.
func (c *controller) terminalDirectory(ctx *executionContext, path string) (rows []os.DirEntry, err error) {
	if _, err = c.requireTerminalEvidence(ctx); err != nil {
		return nil, err
	}
	pinned, err := c.pinDirectory(path)
	if err != nil {
		return nil, err
	}
	fs, err := c.filesystem()
	if err != nil {
		return nil, err
	}
	parent, err := c.pinDirectory(filepath.Dir(path))
	if err != nil {
		return nil, err
	}
	f, err := fs.openDirectoryAt(parent, path, false)
	if err != nil {
		return nil, err
	}
	defer func() { err = errors.Join(err, f.Close()) }()
	want, err := fs.handleIdentity(pinned)
	if err != nil {
		return nil, err
	}
	got, err := fs.handleIdentity(f)
	if err != nil {
		return nil, err
	}
	if want != got {
		return nil, fail("FORENSIC_DIRECTORY_IDENTITY_DRIFT")
	}
	for {
		if _, err = c.requireTerminalEvidence(ctx); err != nil {
			return nil, err
		}
		batch, readErr := f.ReadDir(128)
		if _, err = c.requireTerminalEvidence(ctx); err != nil {
			return nil, err
		}
		if len(rows)+len(batch) > maxForensicEntries {
			return nil, fail("FORENSIC_ENTRY_LIMIT")
		}
		rows = append(rows, batch...)
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return nil, readErr
		}
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].Name() < rows[j].Name() })
	return rows, nil
}
func sameDirectoryEntries(a, b []os.DirEntry) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].Name() != b[i].Name() || a[i].Type() != b[i].Type() {
			return false
		}
	}
	return true
}

// The creation ledger is a comparison source, NOT evidence of live identity.
// Observe the actual runtime tree plus Guard via retained native handles. Only
// proven-owned regular files are hashed. Unowned/replaced/reparse/ADS/hardlinked
// entries are explicitly incomplete and never followed, adopted or deleted.
// Evidence output itself is excluded because this snapshot precedes its append.
func (c *controller) remainingOwnedState(ctx *executionContext) (object, error) {
	started := c.now()
	rows := []any{}
	issues := []any{}
	seen := map[string]bool{}
	encodedBytes, visited, issueCount := 0, 0, 0
	var readBytes int64
	current := object{"path": currentPath(c.paths), "state": "NOT_OBSERVED"}
	issue := func(path string, e error) {
		issueCount++
		if len(issues) < 32 {
			issues = append(issues, object{"path": path, "error": boundedFailure(e)})
		}
	}
	add := func(row object) bool {
		n := len(canonical(row))
		if len(rows) >= maxForensicEntries || encodedBytes+n > maxForensicInventoryBytes {
			issue(text(row, "path"), fail("FORENSIC_INVENTORY_SIZE_LIMIT"))
			return false
		}
		encodedBytes += n
		rows = append(rows, row)
		return true
	}
	var walk func(string)
	walk = func(path string) {
		visited++
		if visited > maxForensicEntries {
			issue(path, fail("FORENSIC_ENTRY_LIMIT"))
			return
		}
		if _, e := c.requireTerminalEvidence(ctx); e != nil {
			issue(path, e)
			return
		}
		if len(path) > 1024 {
			issue("PATH_NOT_RETAINED", fail("FORENSIC_PATH_LENGTH_LIMIT"))
			return
		}
		key := pathKey(path)
		row := object{"path": path, "creation_identity": c.created[key]}
		st, e := os.Lstat(path)
		if os.IsNotExist(e) {
			row["state"] = "ABSENT"
			if c.created[key] != "" {
				issue(path, fail("FORENSIC_OWNED_OBJECT_MISSING"))
			}
			add(row)
			return
		}
		if e != nil {
			row["state"] = "UNREADABLE"
			row["error"] = boundedFailure(e)
			issue(path, e)
			add(row)
			return
		}
		row["state"] = "PRESENT"
		row["bytes"] = json.Number(strconvFormatInt(st.Size()))
		row["is_dir"] = st.IsDir()
		row["mode"] = st.Mode().String()
		if e = c.verifySafeExistingPath(path); e != nil {
			row["error"] = boundedFailure(e)
			issue(path, e)
			add(row)
			return
		}
		fs, e := c.filesystem()
		if e != nil {
			issue(path, e)
			add(row)
			return
		}
		var f *os.File
		if st.IsDir() {
			f, e = c.pinDirectory(path)
		} else if st.Mode().IsRegular() {
			f = c.immutablePins[key]
			if f == nil {
				var parent *os.File
				parent, e = c.pinDirectory(filepath.Dir(path))
				if e == nil {
					f, e = fs.openFileAt(parent, path, false, "immutable")
				}
				if e == nil {
					c.immutablePins[key] = f
				}
			}
		} else {
			e = fail("FORENSIC_UNSUPPORTED_OBJECT_TYPE")
		}
		if e != nil {
			row["error"] = boundedFailure(e)
			issue(path, e)
			add(row)
			return
		}
		identity, e := fs.handleIdentity(f)
		row["live_identity"] = identity
		seen[key] = true
		owned := e == nil && c.created[key] != "" && c.created[key] == identity
		row["ownership_matches"] = owned
		if !owned {
			if e == nil {
				e = fail("FORENSIC_OBJECT_NOT_OWNED_OR_IDENTITY_DRIFT")
			}
			row["error"] = boundedFailure(e)
			issue(path, e)
			add(row)
			return
		}
		if st.IsDir() {
			children, e := c.terminalDirectory(ctx, path)
			if e != nil {
				row["error"] = boundedFailure(e)
				issue(path, e)
				add(row)
				return
			}
			row["child_count"] = json.Number(strconvFormatInt(int64(len(children))))
			if !add(row) {
				return
			}
			for _, child := range children {
				if visited >= maxForensicEntries {
					issue(path, fail("FORENSIC_ENTRY_LIMIT"))
					break
				}
				walk(filepath.Join(path, child.Name()))
			}
			again, e := c.terminalDirectory(ctx, path)
			stable := e == nil && sameDirectoryEntries(children, again)
			row["enumeration_stable"] = stable
			if !stable {
				if e == nil {
					e = fail("FORENSIC_DIRECTORY_MEMBERSHIP_DRIFT")
				}
				issue(path, e)
			}
			return
		}
		if e = c.sys.verifyWriteHandle(f, path); e == nil {
			e = c.verifyNoNamedStreams(path)
		}
		if e == nil {
			var links uint32
			links, e = c.sys.hardlinkCount(path)
			row["hardlink_count"] = json.Number(strconvFormatInt(int64(links)))
			if e == nil && links != 1 {
				e = fail("FORENSIC_HARDLINK_REJECTED")
			}
		}
		if e != nil {
			row["error"] = boundedFailure(e)
			issue(path, e)
			add(row)
			return
		}
		live, e := f.Stat()
		if e != nil {
			issue(path, e)
			add(row)
			return
		}
		size := live.Size()
		row["bytes"] = json.Number(strconvFormatInt(size))
		if size < 0 || size > maxStorage-readBytes {
			issue(path, fail("FORENSIC_READ_BYTE_LIMIT"))
			add(row)
			return
		}
		check := func() error { _, e := c.requireTerminalEvidence(ctx); return e }
		h := sha256.New()
		n, e := copyChecked(h, io.NewSectionReader(f, 0, size), check)
		readBytes += n
		if e == nil && n != size {
			e = fail("FORENSIC_FILE_SIZE_DRIFT")
		}
		if e == nil {
			row["sha256"] = hex.EncodeToString(h.Sum(nil))
			if samePath(path, currentPath(c.paths)) {
				current = object{"path": path, "state": "PRESENT", "live_identity": identity, "sha256": row["sha256"], "bytes": row["bytes"]}
				if size > 1<<20 {
					e = fail("FORENSIC_CURRENT_SIZE_LIMIT")
				} else {
					var raw bytes.Buffer
					_, e = copyChecked(&raw, io.NewSectionReader(f, 0, size), check)
					if e == nil {
						var value object
						value, e = decodeObject(raw.Bytes())
						if e == nil {
							current["observed_json"] = value
							current["matches_last_committed_bytes"] = bytes.Equal(raw.Bytes(), c.currentBytes)
							current["matches_last_recorded_transition"] = transitionMatches(value, c.currentSpec)
						}
					}
				}
			}
		}
		if e != nil {
			row["error"] = boundedFailure(e)
			issue(path, e)
		}
		add(row)
	}
	walk(c.paths.testRoot)
	walk(c.paths.guard)
	ledger := []any{}
	keys := make([]string, 0, len(c.created))
	for key := range c.created {
		if withinPath(c.paths.testRoot, key) || samePath(key, c.paths.guard) {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	for _, key := range keys {
		if len(ledger) >= maxForensicEntries {
			issue("LEDGER", fail("FORENSIC_ENTRY_LIMIT"))
			break
		}
		ledger = append(ledger, object{"path_key": key, "creation_identity": c.created[key], "live_observed": seen[key]})
		if !seen[key] {
			issue(key, fail("FORENSIC_LEDGER_OBJECT_NOT_OBSERVED"))
		}
	}
	if text(current, "state") == "NOT_OBSERVED" && issueCount == 0 {
		current["state"] = "ABSENT_IN_COMPLETE_ENUMERATION"
	}
	out := object{
		"scope":              "RUNTIME_ROOT_RECURSIVE_PLUS_GUARD / BEFORE_TERMINAL_EVENT_APPEND / EVIDENCE_OUTPUT_EXCLUDED",
		"snapshot_semantics": "HANDLE_PINNED_CONTENT_WITH_DOUBLE_DIRECTORY_ENUMERATION / NOT_CONTINUOUS_MONITORING",
		"started_at_utc":     started.UTC().Format(time.RFC3339Nano), "finished_at_utc": c.now().UTC().Format(time.RFC3339Nano),
		"complete": issueCount == 0, "objects": rows, "objects_sha256": digest(rows), "creation_ledger": ledger,
		"observed_current": current, "last_committed_current_snapshot_sha256": sha(c.currentBytes),
		"read_bytes": json.Number(strconvFormatInt(readBytes)), "issues": issues, "issue_count": json.Number(strconvFormatInt(int64(issueCount))),
	}
	if issueCount != 0 {
		return out, fail("EXACT_REMAINING_STATE_UNAVAILABLE")
	}
	return out, nil
}

// Report only creation-time owned records; a PID never grants query/kill authority.
func (c *controller) remainingOwnedProcesses(ctx *executionContext) ([]any, error) {
	if _, e := c.requireTerminalEvidence(ctx); e != nil {
		return nil, e
	}
	owners := []*ownedProcess{}
	for w, record := range c.processes {
		if record.ctx == ctx {
			owners = append(owners, w)
		}
	}
	sort.Slice(owners, func(i, j int) bool { return owners[i].startIndex < owners[j].startIndex })
	rows := []any{}
	var result error
	for _, w := range owners {
		r := c.processes[w]
		row := object{"creation_pid": json.Number(strconvFormatInt(int64(w.id))), "start_index": json.Number(strconvFormatInt(int64(w.startIndex))),
			"scenario": w.scenario, "original_handle_record": true, "handle_closed": r.closed}
		if r.closed {
			row["original_process_confirmed_exited_at_cleanup"] = true
		} else {
			alive, e := r.proc.alive()
			row["alive_observation"] = alive
			if e != nil {
				row["observation_error"] = boundedFailure(e)
				result = errors.Join(result, e)
			}
		}
		rows = append(rows, row)
	}
	return rows, result
}
