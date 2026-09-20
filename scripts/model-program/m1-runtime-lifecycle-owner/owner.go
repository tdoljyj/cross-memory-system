package main

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type layout struct {
	sourceRoot, sourceModel, sourceAsset, sourceRuntime string
	testRoot, tempRoot, guard, guardParent, evidence    string
}

var productionLayout = layout{
	sourceRoot: sourcePackageRoot, sourceModel: sourceModelPath, sourceAsset: sourceRuntimeAssetPath, sourceRuntime: sourceRuntimeDir,
	testRoot: testRoot, tempRoot: tempRoot, guard: attemptGuardPath, guardParent: guardParentPath, evidence: evidenceDir,
}

type directoryIdentity struct {
	canonicalPath            string
	filesystemType           string
	volumeSerial             string
	fileID                   string
	ownerSID                 string
	securityDescriptorSHA256 string
}

type launchEnvelope struct {
	executable string
	argv       []string
	env        []string
	cwd        string
}

type process interface {
	pid() int
	alive() (bool, error)
	graceful() error
	kill() error
	wait(time.Duration) error
	close() error
}

type platform interface {
	physical() (string, string, error)
	windowsDirectory() (string, error)
	pathIsReparse(string) (bool, error)
	finalPath(string) (string, error)
	directoryIdentity(string) (directoryIdentity, error)
	verifyWriteHandle(*os.File, string) error
	hardlinkCount(string) (uint32, error)
	namedStreams(string) ([]string, error)
	atomicPublish(temp, dst string, replace bool) error
	start(launchEnvelope, io.Writer, io.Writer) (process, error)
	portFree() bool
	roundTrip(*http.Request) (*http.Response, error)
}

type admission struct{ publicKey, publicKeyFingerprint, sourceDigest, binaryDigest string }

type budget struct {
	mu                   sync.Mutex
	limit, used, reserve int64
	failure              error
}

func (b *budget) consume(n int64, capture bool) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.failure != nil && capture {
		return b.failure
	}
	ceiling := b.limit
	if capture {
		ceiling -= b.reserve
	}
	if n < 0 || n > ceiling-b.used {
		e := fail("OUTPUT_STORAGE_BUDGET_EXCEEDED")
		b.failure = e
		return e
	}
	b.used += n
	return nil
}
func (b *budget) latch(e error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.failure == nil {
		b.failure = e
	}
}
func (b *budget) err() error { b.mu.Lock(); defer b.mu.Unlock(); return b.failure }

type captureWriter struct {
	f *os.File
	b *budget
}

func (w *captureWriter) Write(p []byte) (int, error) {
	if e := w.b.consume(int64(len(p)), true); e != nil {
		// Keep draining the child's pipe after the evidence budget has failed so
		// cleanup cannot deadlock behind a full stdout/stderr pipe.
		return len(p), nil
	}
	n, err := w.f.Write(p)
	if err != nil {
		w.b.latch(err)
	}
	return n, err
}

type executionContext struct {
	profile           object
	profileDigest     string
	started, deadline time.Time
	expires           time.Time
	physical          string
	starts            int
	budget            *budget
	consumed          bool
}
type contextRecord struct {
	payload           payloadPolicy
	profileDigest     string
	started, deadline time.Time
	expires           time.Time
	physical          string
	starts            int
	budget            *budget
	consumed          bool
}

type ownedProcess struct {
	id              int
	scenario, label string
	startIndex      int
}
type processRecord struct {
	ctx            *executionContext
	proc           process
	stdout, stderr *os.File
	closed         bool
}

type controller struct {
	payload       payloadPolicy
	sys           platform
	trust         admission
	paths         layout
	now           func() time.Time
	contexts      map[*executionContext]*contextRecord
	processes     map[*ownedProcess]*processRecord
	immutablePins map[string]*os.File
	dirPins       map[string]*os.File
	created       map[string]string
	currentBytes  []byte
	currentSpec   transitionSpec
	finalized     map[*executionContext]error
	completed     map[*executionContext]bool
}

func newController(sys platform, trust admission, paths layout) *controller {
	return &controller{payload: reviewedPayload(), sys: sys, trust: trust, paths: paths, now: time.Now, contexts: map[*executionContext]*contextRecord{}, processes: map[*ownedProcess]*processRecord{}, immutablePins: map[string]*os.File{}, dirPins: map[string]*os.File{}, created: map[string]string{}, finalized: map[*executionContext]error{}, completed: map[*executionContext]bool{}}
}

func (c *controller) requireContext(ctx *executionContext) error {
	if ctx == nil {
		return fail("EXECUTION_CONTEXT_REQUIRED")
	}
	r, ok := c.contexts[ctx]
	if !ok {
		return fail("EXECUTION_CONTEXT_REQUIRED")
	}
	if c.payload != r.payload || digest(ctx.profile) != r.profileDigest ||
		ctx.profileDigest != r.profileDigest ||
		ctx.started != r.started ||
		ctx.deadline != r.deadline ||
		ctx.expires != r.expires ||
		ctx.physical != r.physical ||
		ctx.starts != r.starts ||
		ctx.budget != r.budget ||
		ctx.consumed != r.consumed ||
		!ctx.consumed {
		return fail("EXECUTION_CONTEXT_TAMPERED")
	}
	return nil
}
func (c *controller) limits(ctx *executionContext) error {
	if e := c.requireContext(ctx); e != nil {
		return e
	}
	if e := ctx.budget.err(); e != nil {
		return e
	}
	if !ctx.expires.IsZero() && !c.now().Before(ctx.expires) {
		return fail("PROFILE_EXPIRED_OR_REVOKED")
	}
	if !c.now().Before(ctx.deadline) {
		return fail("MAX_WALL_TIME_EXCEEDED")
	}
	return nil
}

func (c *controller) authorize(p object) (ctx *executionContext, err error) {
	defer func() {
		if err != nil && ctx != nil {
			err = c.finalizeAttempt(ctx, err)
		}
	}()
	if c.payload != reviewedPayload() || c.paths != productionLayout {
		return nil, fail("NATIVE_REVIEWED_LAYOUT_OR_PAYLOAD_DRIFT")
	}
	if e := validateStatic(p, c.now().UTC(), c.trust.publicKeyFingerprint); e != nil {
		return nil, e
	}
	if e := verifySignature(p, c.trust.publicKey); e != nil {
		return nil, e
	}
	if !isHex(c.trust.sourceDigest, 64) || text(p, "code_revision/required_effectful_owner_source_manifest_sha256") != c.trust.sourceDigest {
		return nil, fail("NATIVE_SOURCE_BINDING_DRIFT")
	}
	if !isHex(c.trust.binaryDigest, 64) || text(p, "code_revision/required_effectful_owner_binary_sha256") != c.trust.binaryDigest {
		return nil, fail("NATIVE_BINARY_BINDING_DRIFT")
	}
	name, machine, e := c.sys.physical()
	if e != nil {
		return nil, e
	}
	if strings.ToUpper(name) != "DESK-W-591" || machine != machineSHA {
		return nil, fail("DEVICE_PHYSICAL_IDENTITY_DRIFT")
	}
	start := c.now()
	expiry, e := utc(text(p, "expiry"))
	if e != nil {
		return nil, fail("EXPIRY_INVALID")
	}
	deadline := earlierDeadline(start.Add(maxWall), expiry)
	if _, e = c.attestSource(deadline); e != nil {
		return nil, e
	}
	// All checks below are read-only until the exact guard CREATE_NEW. The
	// guard is the first profile-owned filesystem write by construction.
	guardIdentity, e := c.verifyGuardParent(p)
	if e != nil {
		return nil, e
	}
	if e = c.requireAbsent(c.paths.guard, "ATTEMPT_GUARD_ALREADY_EXISTS"); e != nil {
		return nil, e
	}
	if e = c.requireAbsent(c.paths.testRoot, "TEST_ROOT_ALREADY_EXISTS_BEFORE_FIRST_ATTEMPT"); e != nil {
		return nil, e
	}
	if e = c.requireAbsent(c.paths.evidence, "EVIDENCE_OUTPUT_DIR_ALREADY_EXISTS"); e != nil {
		return nil, e
	}
	if !c.sys.portFree() {
		return nil, fail("PORT_18088_ALREADY_IN_USE_BY_NON_PROFILE_PROCESS")
	}
	guardBytes := canonical(object{
		"profile_id": issuedID, "profile_sha256": digest(p), "contract_git_blob_sha1": contractBlobSHA1,
		"claimed_at_utc":                c.now().UTC().Format(time.RFC3339Nano),
		"native_source_manifest_sha256": c.trust.sourceDigest, "native_binary_sha256": c.trust.binaryDigest,
		"guard_parent_identity": object{
			"canonical_path": guardIdentity.canonicalPath, "filesystem_type": guardIdentity.filesystemType,
			"volume_serial": guardIdentity.volumeSerial, "file_id": guardIdentity.fileID,
			"owner_sid": guardIdentity.ownerSID, "security_descriptor_sha256": guardIdentity.securityDescriptorSHA256,
			"empty_parent": true, "non_reparse": true,
		},
		"semantics": "FIRST_PROFILE_OWNED_WRITE / ONE_SHOT / NO_REUSE_AFTER_SUCCESS_OR_FAILURE",
	})
	ctx, e = c.claimGuard(p, start, deadline, expiry, machine, append(guardBytes, '\n'))
	if e != nil {
		return ctx, e
	}

	// Every later path creation is below exact reviewed roots.
	if e = c.limits(ctx); e != nil {
		return ctx, e
	}
	if e = c.createOwnedDirs(ctx); e != nil {
		return ctx, e
	}
	if e = c.writeEvidence(ctx, "M1RuntimeLifecycleAttemptGuard.snapshot.json", object{"path": c.paths.guard, "sha256": sha(append(append([]byte(nil), guardBytes...), '\n')), "claimed_at_utc": c.now().UTC().Format(time.RFC3339Nano)}, false); e != nil {
		return ctx, e
	}
	if e = c.event(ctx, "PROFILE", "attempt_guard_claimed", object{"path": c.paths.guard}); e != nil {
		return ctx, e
	}
	return ctx, nil
}

func (c *controller) requireAbsent(path, code string) error {
	_, e := os.Lstat(path)
	if os.IsNotExist(e) {
		return nil
	}
	if e != nil {
		return e
	}
	return fail(code)
}

func (c *controller) verifyGuardParent(p object) (directoryIdentity, error) {
	st, e := os.Lstat(c.paths.guardParent)
	if e != nil || !st.IsDir() {
		return directoryIdentity{}, fail("ATTEMPT_GUARD_PARENT_MISSING_OR_UNSAFE")
	}
	if e = c.verifySafeExistingPath(c.paths.guardParent); e != nil {
		return directoryIdentity{}, fail("ATTEMPT_GUARD_PARENT_MISSING_OR_UNSAFE")
	}
	guardParentHandle, e := c.pinDirectory(c.paths.guardParent)
	if e != nil {
		return directoryIdentity{}, e
	}
	fs, e := c.filesystem()
	if e != nil {
		return directoryIdentity{}, e
	}
	live, e := fs.directoryIdentityHandle(guardParentHandle)
	if e != nil {
		return directoryIdentity{}, fail("ATTEMPT_GUARD_PARENT_MISSING_OR_UNSAFE")
	}
	bound, ok := get(p, "trusted_execution_bindings/guard_parent_provisioning_identity").(object)
	if !ok ||
		!samePath(live.canonicalPath, c.paths.guardParent) ||
		!samePath(live.canonicalPath, text(bound, "canonical_path")) ||
		!strings.EqualFold(live.filesystemType, text(bound, "filesystem_type")) ||
		!strings.EqualFold(live.volumeSerial, text(bound, "volume_serial")) ||
		!strings.EqualFold(live.fileID, text(bound, "file_id")) ||
		!strings.EqualFold(live.ownerSID, text(bound, "owner_sid")) ||
		!strings.EqualFold(live.securityDescriptorSHA256, text(bound, "security_descriptor_sha256")) ||
		bound["empty_parent"] != true || bound["non_reparse"] != true {
		return directoryIdentity{}, fail("ATTEMPT_GUARD_PARENT_MISSING_OR_UNSAFE")
	}
	rows, e := c.readPinnedDirectory(c.paths.guardParent)
	if e != nil {
		return directoryIdentity{}, e
	}
	if len(rows) != 0 {
		return directoryIdentity{}, fail("ATTEMPT_GUARD_PARENT_MISSING_OR_UNSAFE")
	}
	return live, nil
}

func (c *controller) createOwnedDirs(ctx *executionContext) error {
	for _, p := range []string{c.paths.evidence, c.paths.testRoot, filepath.Join(c.paths.testRoot, "state"), c.paths.tempRoot, filepath.Join(c.paths.testRoot, "revisions")} {
		if e := c.limits(ctx); e != nil {
			return e
		}
		if e := c.createDirExact(p); e != nil {
			return e
		}
	}
	return nil
}
func (c *controller) createNewSynced(path string, data []byte, mode os.FileMode) error {
	f, e := c.openOwnedWrite(path, true)
	if e != nil {
		return e
	}
	return writeSyncClose(f, data)
}

var exactEvidenceOutputs = map[string]bool{
	"M1RuntimeLifecyclePreflight.json": true,
	"M1RuntimeLifecycleEvents.jsonl": true,
	"M1RuntimeLifecycleInstall.json": true,
	"M1RuntimeLifecycleUpgrade.json": true,
	"M1RuntimeLifecycleRollback.json": true,
	"M1RuntimeLifecycleDigests.json": true,
	"M1RuntimeLifecycleCleanup.json": true,
	"M1RuntimeLifecycleCloseout.json": true,
	"M1RuntimeLifecycleAttemptGuard.snapshot.json": true,
}

// writeEvidence is the normal lifecycle evidence capability. It is deliberately
// subject to the live profile deadline/expiry gate; expiry cannot be bypassed
// by routing a normal lifecycle effect through the evidence directory.
func (c *controller) writeEvidence(ctx *executionContext, name string, v any, appendLine bool) error {
	if e := c.limits(ctx); e != nil {
		return e
	}
	return c.writeEvidenceBounded(ctx, name, v, appendLine, false)
}

// writeTerminalEvidence is a narrow post-expiry capability used only by the
// finalizer. It cannot restore lifecycle authority: only the already-authorized
// append-only Events stream is writable, and requireContext still proves the
// exact consumed immutable execution context.
func (c *controller) writeTerminalEvidence(ctx *executionContext, v any) error {
	if e := c.requireContext(ctx); e != nil {
		return e
	}
	return c.writeEvidenceBounded(ctx, "M1RuntimeLifecycleEvents.jsonl", v, true, true)
}

func (c *controller) writeEvidenceBounded(ctx *executionContext, name string, v any, appendLine, terminal bool) error {
	if e := c.requireContext(ctx); e != nil {
		return e
	}
	if filepath.Base(name) != name || name == "" || !exactEvidenceOutputs[name] {
		return fail("EVIDENCE_OUTPUT_NOT_AUTHORIZED")
	}
	if terminal && name != "M1RuntimeLifecycleEvents.jsonl" {
		return fail("TERMINAL_EVIDENCE_OUTPUT_NOT_AUTHORIZED")
	}
	raw := append(canonical(v), '\n')
	if e := ctx.budget.consume(int64(len(raw)), false); e != nil {
		return e
	}
	path := filepath.Join(c.paths.evidence, name)
	if appendLine {
		_, se := os.Lstat(path)
		if se != nil && !os.IsNotExist(se) {
			return se
		}
		f, e := c.openOwnedWrite(path, os.IsNotExist(se))
		if e != nil {
			return e
		}
		return writeSyncClose(f, raw)
	}
	return c.createNewSynced(path, raw, 0600)
}
func (c *controller) event(ctx *executionContext, scenario, kind string, fields object) error {
	row := object{}
	for k, v := range fields {
		row[k] = v
	}
	row["ts_utc"] = c.now().UTC().Format(time.RFC3339Nano)
	row["scenario"] = scenario
	row["kind"] = kind
	return c.writeEvidence(ctx, "M1RuntimeLifecycleEvents.jsonl", row, true)
}

func (c *controller) startServer(ctx *executionContext, slotRoot, scenario, label string) (w *ownedProcess, err error) {
	if e := c.limits(ctx); e != nil {
		return nil, e
	}
	if label == "" || filepath.Base(label) != label {
		return nil, fail("LABEL_PATH_INVALID")
	}
	if ctx.starts >= maxStarts {
		return nil, fail("MAX_SERVER_STARTS_EXCEEDED")
	}
	for _, r := range c.processes {
		if r.ctx == ctx && !r.closed {
			alive, e := r.proc.alive()
			if e != nil {
				return nil, e
			}
			if alive {
				return nil, fail("PARALLEL_SERVER_FORBIDDEN")
			}
		}
	}
	if _, e := c.verifySlot(slotRoot, ctx.deadline); e != nil {
		return nil, e
	}
	env, e := c.exactChildEnvironment()
	if e != nil {
		return nil, e
	}
	launch := serverLaunch(slotRoot, env)
	outPath := filepath.Join(c.paths.evidence, label+".stdout.txt")
	errPath := filepath.Join(c.paths.evidence, label+".stderr.txt")
	if e = c.limits(ctx); e != nil {
		return nil, e
	}
	out, e := c.openOwnedWrite(outPath, true)
	if e != nil {
		return nil, e
	}
	defer func() {
		if w == nil {
			_ = out.Close()
		}
	}()
	if e = c.limits(ctx); e != nil {
		return nil, e
	}
	er, e := c.openOwnedWrite(errPath, true)
	if e != nil {
		return nil, e
	}
	defer func() {
		if w == nil {
			_ = er.Close()
		}
	}()
	if e = c.limits(ctx); e != nil {
		return nil, e
	}
	p, e := c.sys.start(launch, &captureWriter{out, ctx.budget}, &captureWriter{er, ctx.budget})
	if e != nil {
		return nil, e
	}
	idx := ctx.starts + 1
	w = &ownedProcess{id: p.pid(), scenario: scenario, label: label, startIndex: idx}
	c.processes[w] = &processRecord{ctx: ctx, proc: p, stdout: out, stderr: er}
	ctx.starts = idx
	c.contexts[ctx].starts = idx
	defer func() {
		if err != nil {
			if ce := c.forceKill(ctx, w); ce != nil {
				err = fmt.Errorf("%w; cleanup: %v", err, ce)
			}
		}
	}()
	if e = c.event(ctx, scenario, "server_started", object{"pid": p.pid(), "start_index": idx, "executable": launch.executable, "argv": stringsAsAny(launch.argv), "cwd": launch.cwd, "environment_names": []any{"SystemRoot", "WINDIR", "TEMP", "TMP"}, "environment": stringsAsAny(launch.env), "endpoint": "127.0.0.1:18088"}); e != nil {
		return w, e
	}
	return w, nil
}

func stringsAsAny(a []string) []any {
	r := make([]any, len(a))
	for i, v := range a {
		r[i] = v
	}
	return r
}
func (c *controller) resolve(ctx *executionContext, w *ownedProcess) (*processRecord, error) {
	if e := c.requireContext(ctx); e != nil {
		return nil, e
	}
	r, ok := c.processes[w]
	if !ok || w == nil || r.ctx != ctx {
		return nil, fail("FOREIGN_PROCESS_REJECTED")
	}
	return r, nil
}
func (c *controller) ownedAlive(ctx *executionContext, w *ownedProcess) (bool, error) {
	r, e := c.resolve(ctx, w)
	if e != nil {
		return false, e
	}
	if r.closed {
		return false, nil
	}
	return r.proc.alive()
}
func (c *controller) forceKill(ctx *executionContext, w *ownedProcess) error {
	r, e := c.resolve(ctx, w)
	if e != nil {
		return e
	}
	if r.closed {
		return nil
	}
	alive, checkErr := r.proc.alive()
	var killErr error
	if alive || checkErr != nil {
		killErr = r.proc.kill()
	}
	waitErr := r.proc.wait(c.waitTimeout(ctx, 10*time.Second))
	live, postErr := r.proc.alive()
	result := errors.Join(checkErr, killErr, waitErr, postErr)
	if postErr != nil || live {
		return errors.Join(result, fail("ORPHAN_PROFILE_OWNED_SERVER_AFTER_CLEANUP"))
	}
	return errors.Join(result, c.closeProcess(r))
}
func (c *controller) gracefulStop(ctx *executionContext, w *ownedProcess) error {
	r, e := c.resolve(ctx, w)
	if e != nil {
		return e
	}
	if r.closed {
		return nil
	}
	alive, e := r.proc.alive()
	if e != nil {
		return e
	}
	if alive {
		if e = r.proc.graceful(); e != nil {
			return e
		}
	}
	if e = r.proc.wait(c.waitTimeout(ctx, 10*time.Second)); e != nil {
		return e
	}
	return c.closeProcess(r)
}
func (c *controller) closeProcess(r *processRecord) error {
	if r.closed {
		return nil
	}
	if e := r.proc.close(); e != nil {
		return e
	}
	var e1, e2 error
	if r.stdout != nil {
		e1 = r.stdout.Close()
	}
	if r.stderr != nil {
		e2 = r.stderr.Close()
	}
	r.closed = true
	return errors.Join(e1, e2)
}
func (c *controller) cleanupProcesses(ctx *executionContext) error {
	var result error
	for w, r := range c.processes {
		if r.ctx == ctx && !r.closed {
			result = errors.Join(result, c.forceKill(ctx, w))
		}
	}
	for _, r := range c.processes {
		if r.ctx != ctx || r.closed {
			continue
		}
		live, e := r.proc.alive()
		result = errors.Join(result, e)
		if live {
			result = errors.Join(result, fail("ORPHAN_PROFILE_OWNED_SERVER_AFTER_CLEANUP"))
		}
	}
	return result
}
func (c *controller) waitTimeout(ctx *executionContext, ceil time.Duration) time.Duration {
	left := ctx.deadline.Sub(c.now())
	if left <= 0 {
		return time.Second
	}
	if left < ceil {
		return left
	}
	return ceil
}

func (c *controller) exactChildEnvironment() ([]string, error) {
	wd, e := c.sys.windowsDirectory()
	if e != nil {
		return nil, e
	}
	if wd == "" || !filepath.IsAbs(wd) {
		return nil, fail("TRUSTED_WINDOWS_DIRECTORY_INVALID")
	}
	return []string{"SystemRoot=" + wd, "WINDIR=" + wd, "TEMP=" + c.paths.tempRoot, "TMP=" + c.paths.tempRoot}, nil
}
func serverLaunch(slotRoot string, env []string) launchEnvelope {
	exe := filepath.Join(slotRoot, "payload", "runtime", "b11033-vulkan", "llama-server.exe")
	model := filepath.Join(slotRoot, "payload", "model", "Qwen3.5-0.8B-Q8_0.gguf")
	argv := []string{exe, "--model", model, "--offline", "--host", "127.0.0.1", "--port", "18088", "--no-webui", "--threads", "2", "--threads-batch", "2", "--ctx-size", "2048", "--parallel", "1", "--n-gpu-layers", "0", "--device", "none", "--no-op-offload"}
	return launchEnvelope{executable: exe, argv: argv, env: append([]string(nil), env...), cwd: filepath.Join(slotRoot, "payload", "runtime", "b11033-vulkan")}
}

func (c *controller) consumedGuardContext(p object, start, deadline, expiry time.Time, machine string, bytes int64) *executionContext {
	b := &budget{limit: maxStorage, reserve: evidenceReserve, used: bytes}
	ctx := &executionContext{profile: p, profileDigest: digest(p), started: start, deadline: deadline, expires: expiry, physical: machine, budget: b, consumed: true}
	c.contexts[ctx] = &contextRecord{payload: c.payload, profileDigest: ctx.profileDigest, started: start, deadline: deadline, expires: expiry, physical: machine, budget: b, consumed: true}
	return ctx
}

// Called only by authorize after whole-profile admission. Rechecking the same
// pinned parent here closes the validation-to-first-effect interval. No fixture
// or alternate authority route is exposed in the native executable.
func (c *controller) claimGuard(p object, start, deadline, expiry time.Time, machine string, guardRaw []byte) (ctx *executionContext, err error) {
	var e error
	if _, e = c.verifyGuardParent(p); e != nil {
		return nil, e
	}
	if e = checkDeadline(c.now(), deadline, expiry); e != nil {
		return nil, e
	}
	// Consumption is the actual CREATE_NEW, not a later successful Write/Sync.
	guardFile, createErr := c.openOwnedWrite(c.paths.guard, true)
	if createErr != nil {
		var created *createdObjectFailure
		if !errors.As(createErr, &created) {
			return nil, createErr
		}
		ctx = c.consumedGuardContext(p, start, deadline, expiry, machine, int64(len(guardRaw)))
		return ctx, createErr // common finalizer reports even absent evidence directory
	}
	ctx = c.consumedGuardContext(p, start, deadline, expiry, machine, int64(len(guardRaw)))
	if e = checkDeadline(c.now(), deadline, expiry); e != nil {
		return ctx, errors.Join(e, guardFile.Sync(), guardFile.Close())
	}
	if e = writeSyncClose(guardFile, guardRaw); e != nil {
		return ctx, e
	}
	if _, e = c.pinImmutable(c.paths.guard, true); e != nil {
		return ctx, e
	}

	return ctx, nil
}
