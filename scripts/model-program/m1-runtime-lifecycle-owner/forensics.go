package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const forensicEntryLimit = 2048
const forensicRecordLimit = 2 << 20
const forensicReadWall = 30 * time.Second

// This bounded, read-only walk is intentionally not a new lifecycle authority.
// Unknown/replaced/reparse objects are reported, never adopted or traversed.
// Any unreadable state or resource limit makes complete=false and returns an
// error. No missing observation is silently treated as an exact snapshot.
func (c *controller) remainingOwnedState(ctx *executionContext) (object, error) {
	state := object{"complete": false, "observation_semantics": "BOUNDED_SEQUENTIAL_HANDLE_OBSERVATIONS_BEFORE_TERMINAL_APPEND / NOT_ATOMIC_OR_CONTINUOUS",
		"runtime_root": c.paths.testRoot, "guard": c.paths.guard, "evidence_root": c.paths.evidence}
	if e := c.requireContext(ctx); e != nil {
		return state, e
	}
	if !c.finalizing[ctx] {
		return state, fail("TERMINAL_FINALIZER_AUTHORITY_REQUIRED")
	}
	fs, e := c.filesystem()
	if e != nil {
		return state, e
	}
	end := time.Now().Add(forensicReadWall)
	started := time.Now().UTC()
	var result error
	rows := []any{}
	seen := map[string]bool{}
	var readBytes int64
	recordBytes := 0
	stopped := false
	currentObserved := object{"status": "NOT_OBSERVED"}
	check := func() error {
		if e := c.requireContext(ctx); e != nil {
			return e
		}
		if !time.Now().Before(end) {
			return fail("FORENSIC_READ_TIME_LIMIT")
		}
		return nil
	}
	addError := func(row object, err error) {
		row["error"] = boundedDiagnostic(err)
		// Bound diagnostic accumulation; detailed row errors remain in evidence.
		if result == nil {
			result = err
		}
	}
	var visit func(string)
	visit = func(path string) {
		if stopped {
			return
		}
		if e := check(); e != nil {
			result = errors.Join(result, e)
			stopped = true
			return
		}
		if len(rows) >= forensicEntryLimit {
			result = errors.Join(result, fail("FORENSIC_ENTRY_LIMIT"))
			stopped = true
			return
		}
		key := pathKey(path)
		seen[key] = true
		row := object{"path": path, "creation_identity": c.created[key]}
		children := []os.DirEntry{}
		isCurrent := samePath(path, currentPath(c.paths))
		st, err := os.Lstat(path)
		if os.IsNotExist(err) {
			row["exists"] = false
			if c.created[key] != "" {
				addError(row, fail("CREATED_OBJECT_MISSING_AT_FINALIZATION"))
			}
		} else if err != nil {
			addError(row, err)
		} else {
			row["exists"] = true
			row["kind"] = "file"
			if st.IsDir() {
				row["kind"] = "directory"
			}
			row["size"] = st.Size()
			reparse, re := c.sys.pathIsReparse(path)
			if re != nil {
				addError(row, re)
			} else if reparse || st.Mode()&os.ModeSymlink != 0 {
				addError(row, fail("FORENSIC_REPARSE_NOT_TRAVERSED"))
			} else if c.created[key] == "" {
				addError(row, fail("UNOWNED_ENTRY_NOT_ADOPTED_OR_TRAVERSED"))
			} else {
				// A fresh handle, relative to a pinned parent, proves the live
				// identity. A ledger string alone is not a live observation.
				parent, er := c.pinDirectory(filepath.Dir(path))
				var f *os.File
				if er == nil {
					if st.IsDir() {
						f, er = fs.openDirectoryAt(parent, path, false)
					} else if st.Mode().IsRegular() {
						f, er = fs.openFileAt(parent, path, false, "immutable")
					} else {
						er = fail("FORENSIC_NON_REGULAR_OBJECT")
					}
				}
				if er == nil {
					id, ie := fs.handleIdentity(f)
					row["live_handle_identity"] = id
					row["identity_matches_creation"] = ie == nil && id == c.created[key]
					if ie != nil {
						er = ie
					} else if id != c.created[key] {
						er = fail("FORENSIC_LIVE_IDENTITY_MISMATCH")
					}
					if er == nil {
						er = c.sys.verifyWriteHandle(f, path)
					}
					var live os.FileInfo
					if er == nil {
						live, er = f.Stat()
					}
					if er == nil && live.IsDir() != st.IsDir() {
						er = fail("FORENSIC_TYPE_DRIFT")
					}
					if er == nil {
						row["size"] = live.Size()
						row["mtime_utc"] = live.ModTime().UTC().Format(time.RFC3339Nano)
						if live.IsDir() {
							// Bounded enumeration from that exact handle.
							children, er = f.ReadDir(forensicEntryLimit + 1)
							if er == io.EOF {
								er = nil
							}
							if len(children) > forensicEntryLimit {
								er = fail("FORENSIC_DIRECTORY_ENTRY_LIMIT")
								children = nil
							}
						} else {
							er = c.verifyNoNamedStreams(path)
							if er == nil {
								links, le := c.sys.hardlinkCount(path)
								row["hardlink_count"] = int64(links)
								if le != nil {
									er = le
								} else if links != 1 {
									er = fail("FORENSIC_HARDLINK_ALIAS")
								}
							}
							if er == nil {
								h := sha256.New()
								var raw bytes.Buffer
								var writer io.Writer = h
								if isCurrent {
									writer = io.MultiWriter(h, &raw)
								}
								// Entire regular-file content is read under an
								// immutable handle, but never beyond the fixed
								// profile storage bound or forensic deadline.
								limit := maxStorage - readBytes
								if isCurrent && limit > 1<<20 {
									limit = 1 << 20
								}
								n, ce := copyChecked(writer, io.LimitReader(f, limit+1), check)
								readBytes += n
								if ce != nil {
									er = ce
								} else if n > limit {
									er = fail("FORENSIC_CONTENT_READ_LIMIT")
								} else if n != live.Size() {
									er = fail("FORENSIC_CONTENT_SIZE_DRIFT")
								} else {
									post, pe := f.Stat()
									if pe != nil {
										er = pe
									} else if post.Size() != live.Size() || !post.ModTime().Equal(live.ModTime()) {
										er = fail("FORENSIC_CONTENT_CHANGED_DURING_READ")
									}
								}
								if er == nil {
									row["sha256"] = hex.EncodeToString(h.Sum(nil))
									if isCurrent {
										m, de := decodeObject(raw.Bytes())
										currentObserved = object{"status": "OBSERVED", "sha256": row["sha256"], "bytes": n, "content": m,
											"matches_last_observed_bytes": bytes.Equal(raw.Bytes(), c.currentBytes), "live_handle_identity": id}
										if de != nil {
											currentObserved["status"] = "INVALID_JSON"
											currentObserved["decode_error"] = boundedDiagnostic(de)
											er = de
										}
									}
								}
							}
						}
					}
					er = errors.Join(er, f.Close())
				}
				if er != nil {
					children = nil
					addError(row, er)
				}
			}
		}
		if isCurrent && currentObserved["status"] == "NOT_OBSERVED" {
			currentObserved = object{"status": "UNAVAILABLE", "observation": row}
			if row["exists"] == false {
				currentObserved["status"] = "ABSENT"
			}
		}
		size := len(canonical(row))
		if recordBytes+size > forensicRecordLimit {
			result = errors.Join(result, fail("FORENSIC_RECORD_SIZE_LIMIT"))
			stopped = true
			return
		}
		recordBytes += size
		rows = append(rows, row)
		sort.Slice(children, func(i, j int) bool { return children[i].Name() < children[j].Name() })
		for _, child := range children {
			n := child.Name()
			if n == "." || n == ".." || filepath.Base(n) != n || strings.ContainsAny(n, `/\:`) {
				result = errors.Join(result, fail("FORENSIC_UNSAFE_LEAF"))
				stopped = true
				return
			}
			visit(filepath.Join(path, n))
		}
	}
	for _, root := range []string{c.paths.guard, c.paths.testRoot, c.paths.evidence} {
		visit(root)
	}
	// Preserve ledger entries missing from the live enumeration; a disappeared
	// object or an incomplete traversal cannot vanish from the report.
	missing := []any{}
	keys := make([]string, 0, len(c.created))
	for key := range c.created {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if !seen[key] {
			if len(missing) >= forensicEntryLimit {
				result = errors.Join(result, fail("FORENSIC_LEDGER_LIMIT"))
				break
			}
			missing = append(missing, object{"path_key": key, "creation_identity": c.created[key]})
			if result == nil {
				result = fail("CREATION_LEDGER_NOT_FULLY_OBSERVED")
			}
		}
	}
	// A complete bounded enumeration that did not encounter Current proves
	// absence; do not resolve Current by pathname through an unsafe ancestry.
	if currentObserved["status"] == "NOT_OBSERVED" && result == nil && !stopped {
		currentObserved = object{"status": "ABSENT"}
	}
	processRows := []any{}
	for w, record := range c.processes {
		if record.ctx != ctx {
			continue
		}
		row := object{"pid": w.id, "scenario": w.scenario, "start_index": w.startIndex, "original_handle_closed": record.closed}
		if !record.closed {
			alive, e := record.proc.alive()
			row["observed_alive"] = alive
			row["observation_error"] = boundedDiagnostic(e)
			if e != nil {
				result = errors.Join(result, e)
			}
		}
		processRows = append(processRows, row)
	}
	sort.Slice(processRows, func(i, j int) bool {
		return processRows[i].(object)["pid"].(int) < processRows[j].(object)["pid"].(int)
	})
	state["profile_owned_process_handles"] = processRows
	if result != nil {
		result = errors.Join(fail("EXACT_REMAINING_STATE_UNAVAILABLE"), result)
	}
	state["entries"] = rows
	state["unobserved_creation_ledger"] = missing
	state["current"] = currentObserved
	state["content_bytes_read"] = readBytes
	state["started_at_utc"] = started.Format(time.RFC3339Nano)
	state["ended_at_utc"] = time.Now().UTC().Format(time.RFC3339Nano)
	state["complete"] = result == nil
	state["error"] = boundedDiagnostic(result)
	return state, result
}
