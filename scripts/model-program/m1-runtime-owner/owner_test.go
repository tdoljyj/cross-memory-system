package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type fakeProcess struct {
	id, kills, signals, waits, rssCalls, polls, closes int
	live                                               bool
	rssErr                                             error
}

func (p *fakeProcess) pid() int             { return p.id }
func (p *fakeProcess) alive() (bool, error) { p.polls++; return p.live, nil }
func (p *fakeProcess) rss() (uint64, error) { p.rssCalls++; return 123456, p.rssErr }
func (p *fakeProcess) graceful() error      { p.signals++; p.live = false; return nil }
func (p *fakeProcess) kill() error          { p.kills++; p.live = false; return nil }
func (p *fakeProcess) wait(time.Duration) error {
	p.waits++
	if p.live {
		return fail("PROCESS_EXIT_TIMEOUT")
	}
	return nil
}
func (p *fakeProcess) close() error { p.closes++; return nil }

type fakePlatform struct {
	starts        int
	next          *fakeProcess
	all           []*fakeProcess
	name, machine string
	healthFail    bool
	trace         *[]string
}

func (f *fakePlatform) physical() (string, string, error) { return f.name, f.machine, nil }
func (f *fakePlatform) attestFiles(time.Time) error       { return nil }
func (f *fakePlatform) portFree() bool                    { return true }
func (f *fakePlatform) start(cmd []string, out, errOut io.Writer) (process, error) {
	f.starts++
	p := f.next
	if p == nil {
		p = &fakeProcess{id: 42420 + f.starts, live: true}
	}
	f.next = nil
	f.all = append(f.all, p)
	return p, nil
}
func (f *fakePlatform) roundTrip(req *http.Request) (*http.Response, error) {
	if req.URL.Host != "127.0.0.1:18087" || req.URL.Scheme != "http" {
		return nil, fail("MOCK_NON_LOOPBACK")
	}
	status := 200
	body := `{"content":"OK"}`
	if req.URL.Path == "/health" && f.healthFail {
		status = 503
	}
	if req.Body != nil {
		raw, _ := io.ReadAll(req.Body)
		if bytes.Contains(raw, []byte(`"stream":true`)) {
			body = "data: {\"content\":\"1\",\"stop\":false}\n\n"
		}
	}
	return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: http.Header{}}, nil
}
func set(p object, path string, v any) {
	parts := strings.Split(path, "/")
	m := p
	for _, k := range parts[:len(parts)-1] {
		next, ok := m[k].(object)
		if !ok {
			next = object{}
			m[k] = next
		}
		m = next
	}
	m[parts[len(parts)-1]] = v
}
func testProfile() object {
	p := object{"status": "ISSUED"}
	for k, v := range scopePolicy() {
		set(p, k, v)
	}
	a := object{"present": true, "authorization_id": "TEST-ONLY-NOT-ISSUED", "owner_message": "mock only; not Owner authorization", "authorized_profile_id": issuedID, "authorized_authority_effect": authorityEffect, "issued_at_utc": "2026-09-19T10:00:00Z"}
	a["sha256"] = digest(a)
	p["owner_final_execution_authorization"] = a
	p["trusted_execution_bindings"] = object{"expected_owner_authorization_id": a["authorization_id"], "expected_owner_authorization_sha256": a["sha256"]}
	p["expiry"] = "2099-01-01T00:00:00Z"
	p["prohibited_operations"] = stringsAsAny([]string{"TERMINATE_NON_TEST_OWNED_PROCESS", "M1_08_EXECUTION", "TRAINING", "DISTILLATION", "PROMOTION", "ACTIVATION", "PRODUCTION_DEPLOYMENT"})
	set(p, "code_revision/native_owner_source_manifest_sha256", strings.Repeat("a", 64))
	set(p, "code_revision/native_owner_binary_sha256", strings.Repeat("b", 64))
	return p
}

type fixture struct {
	c    *controller
	p    object
	f    *fakePlatform
	priv ed25519.PrivateKey
	root string
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	pub, priv, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	root := t.TempDir()
	f := &fakePlatform{name: "DESK-W-591", machine: machineSHA}
	c := newController(f, admission{hex.EncodeToString(pub), strings.Repeat("a", 64), strings.Repeat("b", 64)}, filepath.Join(root, "guard.json"))
	c.now = func() time.Time { return time.Date(2026, 9, 19, 14, 0, 0, 0, time.UTC) }
	x := &fixture{c: c, p: testProfile(), f: f, priv: priv, root: root}
	x.sign()
	return x
}
func (x *fixture) sign() {
	x.p["owner_signature"] = object{"algorithm": "Ed25519-CLUED-CANONICAL-JSON-v1", "signature_base64": base64.StdEncoding.EncodeToString(ed25519.Sign(x.priv, canonical(copyWithout(x.p, "owner_signature"))))}
}
func (x *fixture) context(t *testing.T) *executionContext {
	t.Helper()
	ctx, e := x.c.authorize(x.p, filepath.Join(x.root, "output"))
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() {
		if e := x.c.cleanupAll(ctx); e != nil {
			t.Error(e)
		}
	})
	return ctx
}
func wantCode(t *testing.T, e error, code string) {
	t.Helper()
	if e == nil || codeOf(e) != code {
		t.Fatalf("want %s, got %v", code, e)
	}
}
func noError(t *testing.T, e error) {
	t.Helper()
	if e != nil {
		t.Fatal(e)
	}
}
func readRows(t *testing.T, path string) []object {
	t.Helper()
	b, e := os.ReadFile(path)
	noError(t, e)
	rows := []object{}
	for _, line := range bytes.Split(bytes.TrimSpace(b), []byte{'\n'}) {
		v, e := decodeProfile(line)
		noError(t, e)
		rows = append(rows, v)
	}
	return rows
}

// These subtest names exactly identify the Python lifecycle tests migrated
// from the deleted Python owner. They execute the SHIPPED native controller,
// substituting only the OS/HTTP backend and the test-only issuance key.
func TestLegacy(t *testing.T) {
	t.Run("test_server_start_health_failure_still_has_process_start_rss_evidence", func(t *testing.T) {
		x := newFixture(t)
		ctx := x.context(t)
		x.f.healthFail = true
		n := 0
		start := ctx.started
		x.c.now = func() time.Time { n++; return start.Add(time.Duration(n) * 31 * time.Second) }
		e := x.c.oneScenario(ctx, "M1-07-PC-CANCEL-001", "cancel", func(*ownedProcess) error { return nil })
		wantCode(t, e, "HEALTH_TIMEOUT")
		rows := readRows(t, filepath.Join(ctx.output, "M1RuntimeStabilityProcessMetrics.jsonl"))
		r := rows[0]
		if r["sample"] != "process-start" || r["scenario"] != "M1-07-PC-CANCEL-001" || r["start_label"] != "cancel" || r["process_created"] != true || r["rss_capture_succeeded"] != true || r["initial_rss_bytes"] != json.Number("123456") || r["start_index"] != json.Number("1") {
			t.Fatal(r)
		}
		if x.f.starts != 1 || x.f.all[0].kills != 1 {
			t.Fatal("cleanup/start count", x.f.starts)
		}
	})
	t.Run("test_rss_failure_after_popen_is_evidenced_then_fails_closed", func(t *testing.T) {
		x := newFixture(t)
		ctx := x.context(t)
		p := &fakeProcess{id: 42421, live: true, rssErr: fail("PROCESS_METRICS_READ_FAILED")}
		x.f.next = p
		_, e := x.c.startServer(ctx, "M1-07-PC-LOAD-001", "rss-fail")
		wantCode(t, e, "PROCESS_METRICS_READ_FAILED")
		rows := readRows(t, filepath.Join(ctx.output, "M1RuntimeStabilityProcessMetrics.jsonl"))
		r := rows[0]
		if r["process_created"] != true || r["rss_capture_succeeded"] != false || r["rss_failure_code"] != "PROCESS_METRICS_READ_FAILED" || p.kills != 1 {
			t.Fatal(r, p)
		}
	})
	t.Run("test_stdout_stderr_attempt_to_exceed_storage_ceiling_fails_closed", func(t *testing.T) {
		b := &budget{limit: 256, reserve: 64}
		f, e := os.Create(filepath.Join(t.TempDir(), "capture.log"))
		noError(t, e)
		defer f.Close()
		w := captureWriter{f, b}
		_, e = w.Write(bytes.Repeat([]byte("x"), 1024))
		noError(t, e)
		wantCode(t, b.err(), "OUTPUT_STORAGE_BUDGET_EXCEEDED")
		st, e := f.Stat()
		noError(t, e)
		if st.Size() > 192 {
			t.Fatal(st.Size())
		}
	})
	t.Run("test_process_start_evidence_can_use_reserved_bytes_after_capture_failure", func(t *testing.T) {
		b := &budget{limit: 512, reserve: 256}
		wantCode(t, b.reserveBytes(300, true, false), "OUTPUT_STORAGE_BUDGET_EXCEEDED")
		noError(t, b.reserveBytes(40, false, true))
		if b.used > 512 {
			t.Fatal(b.used)
		}
	})
	t.Run("test_wall_deadline_inside_scenario_fails_closed", func(t *testing.T) {
		x := newFixture(t)
		ctx := x.context(t)
		x.c.now = func() time.Time { return ctx.deadline.Add(time.Millisecond) }
		wantCode(t, x.c.health(ctx, time.Minute), "MAX_WALL_TIME_EXCEEDED")
		if x.f.starts != 0 {
			t.Fatal("unexpected start")
		}
	})
	t.Run("test_candidate_cannot_forge_registered_execution_context", func(t *testing.T) {
		x := newFixture(t)
		ctx := x.context(t)
		forged := *ctx
		_, e := x.c.startServer(&forged, "M1-07-PC-LOAD-001", "forged")
		wantCode(t, e, "EXECUTION_CONTEXT_REQUIRED")
		if x.f.starts != 0 {
			t.Fatal("start_count !=0")
		}
		t.Log("Test A: start_count=0")
	})
	t.Run("test_authorized_context_tamper_is_rejected_before_popen", func(t *testing.T) {
		for _, field := range []string{"profile", "deadline", "events", "budget"} {
			t.Run(field, func(t *testing.T) {
				x := newFixture(t)
				ctx := x.context(t)
				old := *ctx
				switch field {
				case "profile":
					set(ctx.profile, "config_revision/server/port", 18088)
				case "deadline":
					ctx.deadline = ctx.deadline.Add(time.Second)
				case "events":
					ctx.events = "foreign"
				case "budget":
					ctx.budget = &budget{limit: storageLimit}
				}
				_, e := x.c.startServer(ctx, "x", "tampered")
				wantCode(t, e, "EXECUTION_CONTEXT_TAMPERED")
				if x.f.starts != 0 {
					t.Fatal("start_count !=0")
				}
				*ctx = old
				if field == "profile" {
					set(ctx.profile, "config_revision/server/port", 18087)
				}
			})
		}
	})
	t.Run("test_foreign_popen_cannot_be_forged_into_owned_registry", func(t *testing.T) {
		x := newFixture(t)
		ctx := x.context(t)
		foreign := &fakeProcess{id: 99998, live: true}
		forged := &ownedProcess{pid: foreign.id, label: "foreign", scenario: "M1-07-PC-CRASH-001", startIndex: 99}
		wantCode(t, x.c.forceKill(ctx, forged), "FOREIGN_PROCESS_REJECTED")
		if foreign.kills != 0 {
			t.Fatal("foreign kill")
		}
		t.Log("Test B: foreign kill_count=0")
	})
	t.Run("test_registered_wrapper_metadata_cannot_redirect_internal_process", func(t *testing.T) {
		x := newFixture(t)
		ctx := x.context(t)
		original := &fakeProcess{id: 42423, live: true}
		foreign := &fakeProcess{id: 42423, live: true}
		x.f.next = original
		w, e := x.c.startServer(ctx, "M1-07-PC-LOAD-001", "original")
		noError(t, e)
		w.pid = 99999
		w.label = "mutated"
		w.scenario = "mutated"
		w.startIndex = 99999
		noError(t, x.c.metrics(ctx, w, "after-mutation"))
		alive, e := x.c.alive(ctx, w)
		noError(t, e)
		if !alive {
			t.Fatal("not alive")
		}
		noError(t, x.c.forceKill(ctx, w))
		if original.kills != 1 || foreign.kills != 0 || original.closes != 1 {
			t.Fatal(original, foreign)
		}
		t.Log("Positive control: original kill_count=1; foreign kill_count=0; four diagnostic fields mutated")
	})
	t.Run("test_foreign_popen_passed_to_kill_is_rejected", func(t *testing.T) {
		x := newFixture(t)
		ctx := x.context(t)
		foreign := &fakeProcess{id: 99999, live: true}
		wantCode(t, x.c.forceKill(ctx, &ownedProcess{pid: foreign.id}), "FOREIGN_PROCESS_REJECTED")
		if !foreign.live || foreign.kills != 0 {
			t.Fatal("foreign touched")
		}
	})
	t.Run("test_owned_process_from_other_context_is_rejected", func(t *testing.T) {
		x := newFixture(t)
		a := x.context(t)
		y := newFixture(t)
		b := y.context(t)
		w, e := x.c.startServer(a, "x", "owned")
		noError(t, e)
		wantCode(t, x.c.forceKill(b, w), "EXECUTION_CONTEXT_REQUIRED")
		if x.f.all[0].kills != 0 {
			t.Fatal("cross context kill")
		}
		noError(t, x.c.forceKill(a, w))
	})
}

func TestNativeBoundary(t *testing.T) {
	t.Run("candidate_no_context_no_guard_no_output_no_start", func(t *testing.T) {
		x := newFixture(t)
		x.p["status"] = "BLOCKED_PENDING_REVIEW_AND_FINAL_ISSUANCE"
		out := filepath.Join(x.root, "deny")
		_, e := x.c.authorize(x.p, out)
		wantCode(t, e, "PROFILE_NOT_ISSUED")
		if len(x.c.contexts) != 0 || x.f.starts != 0 {
			t.Fatal("effect")
		}
		for _, p := range []string{out, x.c.guard} {
			if _, e = os.Stat(p); !os.IsNotExist(e) {
				t.Fatal("created", p)
			}
		}
	})
	t.Run("production_key_is_exact_owner_enrolled_root", func(t *testing.T) {
		key, e := hex.DecodeString(issuerPublicKeyHex)
		noError(t, e)
		if len(key) != ed25519.PublicKeySize {
			t.Fatal("owner root public key length", len(key))
		}
		if sha(key) != issuerPublicKeySHA256 {
			t.Fatal("owner root fingerprint drift")
		}
	})
	t.Run("coedited_self_hash_and_outer_binding_cannot_self_issue", func(t *testing.T) {
		x := newFixture(t)
		set(x.p, "owner_final_execution_authorization/owner_message", "different")
		a := get(x.p, "owner_final_execution_authorization").(object)
		a["sha256"] = digest(copyWithout(a, "sha256"))
		set(x.p, "trusted_execution_bindings/expected_owner_authorization_sha256", a["sha256"])
		noError(t, validateStatic(x.p, x.c.now()))
		wantCode(t, verifySignature(x.p, x.c.trust.publicKey), "OWNER_SIGNATURE_INVALID")
	})
	t.Run("all_static_scope_fields_enforced", func(t *testing.T) {
		for key := range scopePolicy() {
			t.Run(strings.ReplaceAll(key, "/", "_"), func(t *testing.T) {
				x := newFixture(t)
				set(x.p, key, "changed")
				if e := validateStatic(x.p, x.c.now()); e == nil {
					t.Fatal(key)
				}
			})
		}
	})
	t.Run("native_binary_source_bound", func(t *testing.T) {
		for _, field := range []string{"native_owner_binary_sha256", "native_owner_source_manifest_sha256"} {
			x := newFixture(t)
			set(x.p, "code_revision/"+field, strings.Repeat("0", 64))
			x.sign()
			_, e := x.c.authorize(x.p, filepath.Join(x.root, "out"))
			if e == nil {
				t.Fatal(field)
			}
		}
	})
	t.Run("physical_identity_not_hostname_or_json_alone", func(t *testing.T) {
		x := newFixture(t)
		x.f.machine = strings.Repeat("0", 64)
		_, e := x.c.authorize(x.p, filepath.Join(x.root, "out"))
		wantCode(t, e, "DEVICE_PHYSICAL_IDENTITY_DRIFT")
		if len(x.c.contexts) != 0 {
			t.Fatal("context before physical")
		}
	})
	t.Run("one_attempt_atomic_guard", func(t *testing.T) {
		x := newFixture(t)
		x.context(t)
		_, e := x.c.authorize(x.p, filepath.Join(x.root, "second"))
		wantCode(t, e, "MAX_ATTEMPTS_EXCEEDED")
	})
	t.Run("no_parallel_process", func(t *testing.T) {
		x := newFixture(t)
		ctx := x.context(t)
		_, e := x.c.startServer(ctx, "x", "first")
		noError(t, e)
		_, e = x.c.startServer(ctx, "x", "second")
		wantCode(t, e, "PARALLEL_SERVER_FORBIDDEN")
		if x.f.starts != 1 {
			t.Fatal(x.f.starts)
		}
	})
	t.Run("copied_wrapper_same_metadata_denied", func(t *testing.T) {
		x := newFixture(t)
		ctx := x.context(t)
		w, e := x.c.startServer(ctx, "x", "real")
		noError(t, e)
		copy := *w
		wantCode(t, x.c.forceKill(ctx, &copy), "FOREIGN_PROCESS_REJECTED")
		if x.f.all[0].kills != 0 {
			t.Fatal("copy kill")
		}
	})
	t.Run("all_lifecycle_paths_use_original_registry", func(t *testing.T) {
		for _, op := range []string{"kill", "graceful", "cleanup", "metrics", "alive", "capture-cleanup"} {
			t.Run(op, func(t *testing.T) {
				x := newFixture(t)
				ctx := x.context(t)
				original := &fakeProcess{id: 123, live: true}
				foreign := &fakeProcess{id: 123, live: true}
				x.f.next = original
				w, e := x.c.startServer(ctx, "x", "real")
				noError(t, e)
				w.pid = 999
				w.label = "f"
				w.scenario = "f"
				w.startIndex = 99
				switch op {
				case "kill":
					e = x.c.forceKill(ctx, w)
				case "graceful":
					e = x.c.gracefulStop(ctx, w)
				case "cleanup":
					e = x.c.safeCleanup(ctx, w)
				case "metrics":
					e = x.c.metrics(ctx, w, "sample")
				case "alive":
					_, e = x.c.alive(ctx, w)
				case "capture-cleanup":
					original.live = false
					e = x.c.closeCaptures(ctx, w)
				}
				noError(t, e)
				if foreign.kills+foreign.signals+foreign.polls+foreign.rssCalls+foreign.waits+foreign.closes != 0 {
					t.Fatal("foreign side effect")
				}
			})
		}
	})
	t.Run("expiry_and_time_strict", func(t *testing.T) {
		for _, s := range []string{"2026-09-19T10:00:00", "2026-09-19T18:00:00+08:00", "not-a-date"} {
			x := newFixture(t)
			set(x.p, "owner_final_execution_authorization/issued_at_utc", s)
			if e := validateStatic(x.p, x.c.now()); e == nil {
				t.Fatal(s)
			}
		}
	})
	t.Run("duplicate_JSON_rejected", func(t *testing.T) {
		_, e := decodeProfile([]byte(`{"status":"ISSUED","status":"ISSUED"}`))
		wantCode(t, e, "PROFILE_DUPLICATE_KEY")
	})
	t.Run("canonical_unicode_matches_python", func(t *testing.T) {
		if string(canonical(object{"z": "<好>\u2028", "a": 1})) != "{\"a\":1,\"z\":\"<好>\u2028\"}" {
			t.Fatal("canonical drift")
		}
	})
	t.Run("fixed_CLI_no_foreign_process_or_callback_inputs", func(t *testing.T) {
		root := t.TempDir()
		base := []string{filepath.Join(root, "owner.exe"), "--execute", "--profile", filepath.Join(root, "profile.json"), "--output-dir", filepath.Join(root, "out")}
		_, _, _, e := parseLaunch(base)
		noError(t, e)
		for _, flag := range []string{"--pid", "--process", "--registry", "--callback", "--test", "--python", "--issuer-key"} {
			_, _, _, e = parseLaunch(append(append([]string{}, base...), flag, "1"))
			wantCode(t, e, "OWNER_FIXED_ARGUMENT_SCHEMA_REQUIRED")
		}
	})
	t.Run("all_launch_paths_absolute", func(t *testing.T) {
		root := t.TempDir()
		base := []string{filepath.Join(root, "owner.exe"), "--execute", "--profile", filepath.Join(root, "p.json"), "--output-dir", filepath.Join(root, "out")}
		for _, i := range []int{0, 3, 5} {
			a := append([]string{}, base...)
			a[i] = "relative"
			_, _, _, e := parseLaunch(a)
			if e == nil {
				t.Fatal(i)
			}
		}
	})
	t.Run("mock_only_complete_fixed_sequence", func(t *testing.T) {
		x := newFixture(t)
		ctx := x.context(t)
		tick := 0
		start := ctx.started
		x.c.now = func() time.Time { tick++; return start.Add(time.Duration(tick) * time.Second) }
		noError(t, x.c.run(ctx))
		if x.f.starts != 7 {
			t.Fatal(x.f.starts)
		}
		kills := 0
		for _, p := range x.f.all {
			kills += p.kills
			if p.live || p.closes != 1 {
				t.Fatal("orphan", p)
			}
		}
		if kills != 1 {
			t.Fatal("crash count", kills)
		}
		rows := readRows(t, filepath.Join(ctx.output, "M1RuntimeStabilityProcessMetrics.jsonl"))
		starts := 0
		for _, r := range rows {
			if r["sample"] == "process-start" {
				starts++
			}
		}
		if starts != 7 {
			t.Fatal("RSS per start", starts)
		}
		t.Log("FAKE PLATFORM + FAKE HTTP ONLY; 7 starts; 1 forced crash; 7 closed; no real socket/server/model")
	})
}

func TestCLIRejection(t *testing.T) {
	root := t.TempDir()
	p := filepath.Join(root, "candidate.json")
	noError(t, os.WriteFile(p, []byte(`{"status":"BLOCKED_PENDING_REVIEW_AND_FINAL_ISSUANCE"}`), 0600))
	out := filepath.Join(root, "must-not-exist")
	var stdout, stderr bytes.Buffer
	rc := runCLI([]string{filepath.Join(root, "owner.exe"), "--execute", "--profile", p, "--output-dir", out}, &stdout, &stderr)
	if rc != 3 || !strings.Contains(stderr.String(), "PROFILE_NOT_ISSUED") {
		t.Fatal(rc, stderr.String())
	}
	if _, e := os.Stat(out); !os.IsNotExist(e) {
		t.Fatal("output created")
	}
	stdout.Reset()
	stderr.Reset()
	if rc = runCLI([]string{filepath.Join(root, "owner.exe")}, &stdout, &stderr); rc != 0 {
		t.Fatal(rc)
	}
	fmt.Fprintln(&stdout) // keep output validation independent of exact whitespace
	if !strings.Contains(stdout.String(), `"server_started":false`) {
		t.Fatal(stdout.String())
	}
}
