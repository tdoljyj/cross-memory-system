package main

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type process interface {
	pid() int
	alive() (bool, error)
	rss() (uint64, error)
	graceful() error
	kill() error
	wait(time.Duration) error
	close() error
}

// Implementations are compile-time code, never supplied by JSON or an RPC.
// Test doubles exist exclusively in *_test.go, excluded from go build.
type platform interface {
	physical() (string, string, error)
	roundTrip(*http.Request) (*http.Response, error)
	portFree() bool
	attestFiles(time.Time) error
	start([]string, io.Writer, io.Writer) (process, error)
}

type budget struct {
	mu                   sync.Mutex
	limit, used, reserve int64
	failure              error
}

func (b *budget) reserveBytes(n int64, capture, afterFailure bool) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.failure != nil && !afterFailure {
		return b.failure
	}
	ceiling := b.limit
	if capture {
		ceiling -= b.reserve
	}
	if n < 0 || n > ceiling-b.used {
		e := fail("OUTPUT_STORAGE_BUDGET_EXCEEDED")
		if b.failure == nil {
			b.failure = e
		}
		return e
	}
	b.used += n
	return nil
}
func (b *budget) err() error { b.mu.Lock(); defer b.mu.Unlock(); return b.failure }
func (b *budget) setError(e error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.failure == nil {
		b.failure = e
	}
}

type captureWriter struct {
	file *os.File
	b    *budget
}

func (w *captureWriter) Write(p []byte) (int, error) {
	// Drain and discard after failure so a full pipe cannot deadlock cleanup.
	if e := w.b.reserveBytes(int64(len(p)), true, false); e != nil {
		return len(p), nil
	}
	n, e := w.file.Write(p)
	if e != nil {
		w.b.setError(e)
	}
	return n, e
}

type executionContext struct {
	profile               object
	output, events, guard string
	started, deadline     time.Time
	budget                *budget
	count                 int
	physical              string
}
type contextRecord struct {
	profileDigest, output, events, guard, physical string
	started, deadline                              time.Time
	budget                                         *budget
	count                                          int
}
type ownedProcess struct {
	pid             int
	label, scenario string
	startIndex      int
}
type processRecord struct {
	ctx             *executionContext
	proc            process
	label, scenario string
	index           int
	stdout, stderr  *os.File
	closed          bool
}
type admission struct{ publicKey, sourceDigest, binaryDigest string }
type controller struct {
	sys       platform
	trust     admission
	guard     string
	now       func() time.Time
	contexts  map[*executionContext]*contextRecord
	processes map[*ownedProcess]*processRecord
}

func newController(sys platform, trust admission, guard string) *controller {
	return &controller{sys: sys, trust: trust, guard: guard, now: time.Now, contexts: map[*executionContext]*contextRecord{}, processes: map[*ownedProcess]*processRecord{}}
}
func (c *controller) authorize(p object, out string) (*executionContext, error) {
	if e := validateStatic(p, c.now().UTC()); e != nil {
		return nil, e
	}
	if e := verifySignature(p, c.trust.publicKey); e != nil {
		return nil, e
	}
	if len(c.trust.sourceDigest) != 64 || text(p, "code_revision/native_owner_source_manifest_sha256") != c.trust.sourceDigest {
		return nil, fail("NATIVE_SOURCE_BINDING_DRIFT")
	}
	if len(c.trust.binaryDigest) != 64 || text(p, "code_revision/native_owner_binary_sha256") != c.trust.binaryDigest {
		return nil, fail("NATIVE_BINARY_BINDING_DRIFT")
	}
	started := c.now()
	deadline := started.Add(wallLimit)
	name, machine, e := c.sys.physical()
	if e != nil {
		return nil, e
	}
	if name != "DESK-W-591" || machine != machineSHA {
		return nil, fail("DEVICE_PHYSICAL_IDENTITY_DRIFT")
	}
	if e = c.sys.attestFiles(deadline); e != nil {
		return nil, e
	}
	if !filepath.IsAbs(out) {
		return nil, fail("OWNER_ABSOLUTE_PATHS_REQUIRED")
	}
	if _, e = os.Lstat(out); !os.IsNotExist(e) {
		return nil, fail("OUTPUT_MUST_BE_NEW")
	}
	// Atomic persistent one-shot guard. Failed attempts remain consumed.
	if e = os.MkdirAll(filepath.Dir(c.guard), 0700); e != nil {
		return nil, e
	}
	g, e := os.OpenFile(c.guard, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if os.IsExist(e) {
		return nil, fail("MAX_ATTEMPTS_EXCEEDED")
	}
	if e != nil {
		return nil, e
	}
	guardBytes := append(canonical(object{"profile_id": issuedID, "claimed_at_utc": c.now().UTC().Format(time.RFC3339Nano), "output_dir": out, "semantics": "FIRST_EFFECTFUL_ATTEMPT_CONSUMES_PROFILE / NO_REUSE_AFTER_SUCCESS_OR_FAILURE"}), '\n')
	_, e = g.Write(guardBytes)
	if e == nil {
		e = g.Sync()
	}
	ce := g.Close()
	if e == nil {
		e = ce
	}
	if e != nil {
		return nil, e
	}
	if e = os.Mkdir(out, 0700); e != nil {
		return nil, e
	}
	b := &budget{limit: storageLimit, reserve: evidenceReserve, used: int64(len(guardBytes))}
	ctx := &executionContext{profile: p, output: out, events: filepath.Join(out, "M1RuntimeStabilityEvents.jsonl"), guard: c.guard, started: started, deadline: started.Add(wallLimit), budget: b, physical: machine}
	c.contexts[ctx] = &contextRecord{profileDigest: digest(p), output: out, events: ctx.events, guard: c.guard, started: started, deadline: ctx.deadline, budget: b, physical: machine}
	if e = c.event(ctx, "PROFILE", "attempt_guard_claimed", object{"path": c.guard}); e != nil {
		return nil, e
	}
	return ctx, nil
}
func (c *controller) requireContext(ctx *executionContext) error {
	r, ok := c.contexts[ctx]
	if !ok || ctx == nil {
		return fail("EXECUTION_CONTEXT_REQUIRED")
	}
	if digest(ctx.profile) != r.profileDigest || ctx.output != r.output || ctx.events != r.events || ctx.guard != r.guard || ctx.started != r.started || ctx.deadline != r.deadline || ctx.budget != r.budget || ctx.count != r.count || ctx.physical != r.physical {
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
	if !c.now().Before(ctx.deadline) {
		return fail("MAX_WALL_TIME_EXCEEDED")
	}
	return nil
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
func (c *controller) write(ctx *executionContext, name string, v any, appendLine, afterFailure bool) error {
	if e := c.requireContext(ctx); e != nil {
		return e
	}
	if filepath.Base(name) != name {
		return fail("EVIDENCE_PATH_OUTSIDE_OUTPUT")
	}
	if !afterFailure {
		if e := c.limits(ctx); e != nil {
			return e
		}
	}
	b := append(canonical(v), '\n')
	if e := ctx.budget.reserveBytes(int64(len(b)), false, afterFailure); e != nil {
		return e
	}
	flags := os.O_CREATE | os.O_WRONLY
	if appendLine {
		flags |= os.O_APPEND
	} else {
		flags |= os.O_EXCL
	}
	f, e := os.OpenFile(filepath.Join(ctx.output, name), flags, 0600)
	if e != nil {
		return e
	}
	_, e = f.Write(b)
	ce := f.Close()
	if e == nil {
		e = ce
	}
	return e
}
func (c *controller) event(ctx *executionContext, scenario, kind string, fields object) error {
	v := copyWithout(fields, "")
	v["ts_utc"] = c.now().UTC().Format(time.RFC3339Nano)
	v["scenario"] = scenario
	v["kind"] = kind
	return c.write(ctx, "M1RuntimeStabilityEvents.jsonl", v, true, false)
}
func sanitizedServerEnv() []string {
	// The exact llama.cpp runtime reads PROGRAMDATA/APPDATA config.ini and many
	// LLAMA_ARG_* variables before argv. Never inherit those authority surfaces.
	// Keep only OS plumbing required by the Windows child; signed argv remains
	// the sole llama-server configuration source.
	allowed := []string{"SystemRoot", "WINDIR", "TEMP", "TMP"}
	env := make([]string, 0, len(allowed))
	for _, key := range allowed {
		if value, ok := os.LookupEnv(key); ok && value != "" {
			env = append(env, key+"="+value)
		}
	}
	return env
}

func serverCommand() []string {
	return []string{serverPath, "--model", modelPath, "--offline", "--host", "127.0.0.1", "--port", "18087", "--no-webui", "--threads", "2", "--threads-batch", "2", "--ctx-size", "2048", "--parallel", "1", "--n-gpu-layers", "0", "--device", "none", "--no-op-offload"}
}
func stringsAsAny(ss []string) []any {
	a := make([]any, len(ss))
	for i, s := range ss {
		a[i] = s
	}
	return a
}
func (c *controller) startServer(ctx *executionContext, scenario, label string) (w *ownedProcess, err error) {
	if e := c.limits(ctx); e != nil {
		return nil, e
	}
	if ctx.count >= maxStarts {
		return nil, fail("MAX_SERVER_STARTS_EXCEEDED")
	}
	if filepath.Base(label) != label || label == "" {
		return nil, fail("LABEL_PATH_INVALID")
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
	out, e := os.OpenFile(filepath.Join(ctx.output, label+".stdout.txt"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return nil, e
	}
	defer func() {
		if w == nil {
			out.Close()
		}
	}()
	er, e := os.OpenFile(filepath.Join(ctx.output, label+".stderr.txt"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return nil, e
	}
	defer func() {
		if w == nil {
			er.Close()
		}
	}()
	p, e := c.sys.start(serverCommand(), &captureWriter{out, ctx.budget}, &captureWriter{er, ctx.budget})
	if e != nil {
		return nil, e
	}
	// Immediately retain the original process before any later fallible work.
	// There is no caller-supplied process, PID, wrapper or registration command.
	index := c.contexts[ctx].count + 1
	w = &ownedProcess{pid: p.pid(), label: label, scenario: scenario, startIndex: index}
	c.processes[w] = &processRecord{ctx: ctx, proc: p, label: label, scenario: scenario, index: index, stdout: out, stderr: er}
	c.contexts[ctx].count = index
	ctx.count = index
	defer func() {
		if err != nil {
			if cleanupErr := c.safeCleanup(ctx, w); cleanupErr != nil {
				err = fmt.Errorf("%w; cleanup: %v", err, cleanupErr)
			}
		}
	}()
	rss, e := p.rss()
	row := object{"ts_utc": c.now().UTC().Format(time.RFC3339Nano), "scenario": scenario, "sample": "process-start", "start_index": index, "start_label": label, "pid": p.pid(), "process_created": true, "command": stringsAsAny(serverCommand()), "rss_capture_succeeded": e == nil}
	if e != nil {
		row["initial_rss_bytes"] = nil
		row["rss_failure_code"] = codeOf(e)
	} else {
		row["initial_rss_bytes"] = int64(rss)
	}
	if we := c.write(ctx, "M1RuntimeStabilityProcessMetrics.jsonl", row, true, true); we != nil {
		return w, we
	}
	if e != nil {
		return w, e
	}
	if e = c.event(ctx, scenario, "server_started", object{"pid": p.pid(), "start_index": index, "label": label}); e != nil {
		return w, e
	}
	return w, nil
}
func (c *controller) alive(ctx *executionContext, w *ownedProcess) (bool, error) {
	r, e := c.resolve(ctx, w)
	if e != nil {
		return false, e
	}
	if r.closed {
		return false, nil
	}
	return r.proc.alive()
}
func (c *controller) metrics(ctx *executionContext, w *ownedProcess, sample string) error {
	r, e := c.resolve(ctx, w)
	if e != nil {
		return e
	}
	if e = c.limits(ctx); e != nil {
		return e
	}
	rss, e := r.proc.rss()
	if e != nil {
		return e
	}
	return c.write(ctx, "M1RuntimeStabilityProcessMetrics.jsonl", object{"ts_utc": c.now().UTC().Format(time.RFC3339Nano), "scenario": r.scenario, "sample": sample, "start_index": r.index, "start_label": r.label, "pid": r.proc.pid(), "rss_bytes": int64(rss)}, true, false)
}
func (c *controller) closeCaptures(ctx *executionContext, w *ownedProcess) error {
	r, e := c.resolve(ctx, w)
	if e != nil {
		return e
	}
	if r.closed {
		return nil
	}
	if e = r.proc.wait(2 * time.Second); e != nil {
		return e
	}
	e1 := r.stdout.Close()
	e2 := r.stderr.Close()
	e3 := r.proc.close()
	r.closed = true
	if e1 != nil {
		return e1
	}
	if e2 != nil {
		return e2
	}
	return e3
}
func (c *controller) forceKill(ctx *executionContext, w *ownedProcess) error {
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
		if e = r.proc.kill(); e != nil {
			return e
		}
	}
	if e = r.proc.wait(c.waitTimeout(ctx, 10*time.Second)); e != nil {
		return e
	}
	return c.closeCaptures(ctx, w)
}
func (c *controller) gracefulStop(ctx *executionContext, w *ownedProcess) error {
	r, e := c.resolve(ctx, w)
	if e != nil {
		return e
	}
	if e = c.limits(ctx); e != nil {
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
	return c.closeCaptures(ctx, w)
}
func (c *controller) safeCleanup(ctx *executionContext, w *ownedProcess) error {
	return c.forceKill(ctx, w)
}
func (c *controller) cleanupAll(ctx *executionContext) error {
	var first error
	for w, r := range c.processes {
		if r.ctx == ctx {
			if e := c.safeCleanup(ctx, w); e != nil && first == nil {
				first = e
			}
		}
	}
	return first
}

func (c *controller) waitTimeout(ctx *executionContext, ceiling time.Duration) time.Duration {
	left := ctx.deadline.Sub(c.now())
	if left <= 0 {
		return time.Second
	}
	if left < ceiling {
		return left
	}
	return ceiling
}
