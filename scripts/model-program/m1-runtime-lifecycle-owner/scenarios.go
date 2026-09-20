package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
)

func (c *controller) request(ctx *executionContext, method, path string, payload object, timeout time.Duration) (*http.Response, context.CancelFunc, error) {
	if e := c.limits(ctx); e != nil {
		return nil, nil, e
	}
	if path != "/health" && path != "/completion" {
		return nil, nil, fail("LOOPBACK_REQUEST_PATH_FORBIDDEN")
	}
	end := c.now().Add(timeout)
	if ctx.deadline.Before(end) {
		end = ctx.deadline
	}
	reqCtx, cancel := context.WithDeadline(context.Background(), end)
	var body io.Reader
	if payload != nil {
		body = bytes.NewReader(canonical(payload))
	}
	req, e := http.NewRequestWithContext(reqCtx, method, "http://127.0.0.1:18088"+path, body)
	if e != nil {
		cancel()
		return nil, nil, e
	}
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, e := c.sys.roundTrip(req)
	if e != nil {
		cancel()
		return nil, nil, e
	}
	return resp, func() { cancel(); _ = resp.Body.Close() }, nil
}

func (c *controller) sleep(ctx *executionContext, d time.Duration) error {
	end := c.now().Add(d)
	for c.now().Before(end) {
		if e := c.limits(ctx); e != nil {
			return e
		}
		left := end.Sub(c.now())
		if left > 100*time.Millisecond {
			left = 100 * time.Millisecond
		}
		time.Sleep(left)
	}
	return c.limits(ctx)
}

func (c *controller) health(ctx *executionContext, timeout time.Duration) error {
	end := c.now().Add(timeout)
	for c.now().Before(end) {
		resp, closeFn, e := c.request(ctx, "GET", "/health", nil, 2*time.Second)
		if e == nil {
			status := resp.StatusCode
			closeFn()
			if status >= 200 && status < 300 {
				return nil
			}
		}
		if e = c.sleep(ctx, 100*time.Millisecond); e != nil {
			return e
		}
	}
	return fail("HEALTH_TIMEOUT")
}

func (c *controller) probe(ctx *executionContext) error {
	payload := object{
		"prompt":      "Reply with exactly: OK",
		"n_predict":   json.Number("8"),
		"temperature": json.Number("0"),
		"stream":      false,
	}
	resp, closeFn, e := c.request(ctx, "POST", "/completion", payload, 30*time.Second)
	if e != nil {
		return e
	}
	defer closeFn()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fail("PROBE_HTTP_FAILURE")
	}
	raw, e := io.ReadAll(io.LimitReader(resp.Body, (1<<20)+1))
	if e != nil {
		return e
	}
	if len(raw) > 1<<20 {
		return fail("PROBE_RESPONSE_LIMIT")
	}
	var result struct {
		Content string `json:"content"`
	}
	if e = json.Unmarshal(raw, &result); e != nil {
		return e
	}
	if strings.TrimSpace(result.Content) != "OK" {
		return fail("MINIMAL_PROBE_SEMANTICS_FAILED")
	}
	return c.limits(ctx)
}

func port18088Free() bool {
	l, e := net.Listen("tcp4", "127.0.0.1:18088")
	if e != nil {
		return false
	}
	_ = l.Close()
	return true
}
func (realPlatform) portFree() bool { return port18088Free() }

func (realPlatform) roundTrip(req *http.Request) (*http.Response, error) {
	if req == nil || req.URL == nil || req.URL.Scheme != "http" || req.URL.Host != "127.0.0.1:18088" {
		return nil, fail("NON_LOOPBACK_OR_ENDPOINT_DRIFT")
	}
	tr := &http.Transport{
		Proxy:                 nil,
		DisableKeepAlives:     true,
		DialContext:           (&net.Dialer{Timeout: 2 * time.Second}).DialContext,
		ResponseHeaderTimeout: 30 * time.Second,
	}
	client := &http.Client{
		Transport: tr,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return fail("HTTP_REDIRECT_FORBIDDEN")
		},
	}
	return client.Do(req)
}

func (c *controller) portReleased(ctx *executionContext) error {
	end := c.now().Add(10 * time.Second)
	for c.now().Before(end) {
		if c.sys.portFree() {
			return nil
		}
		if e := c.sleep(ctx, 100*time.Millisecond); e != nil {
			return e
		}
	}
	return fail("PORT_RELEASE_TIMEOUT")
}

func (c *controller) probeActiveSlot(ctx *executionContext, revision, scenario, label string) (err error) {
	if e := c.requireCurrentRevision(ctx, revision); e != nil {
		return e
	}
	if !c.sys.portFree() {
		return fail("PORT_18088_ALREADY_IN_USE_BY_NON_PROFILE_PROCESS")
	}
	slot := slotRootFor(c.paths, revision)
	w, e := c.startServer(ctx, slot, scenario, label)
	if e != nil {
		return e
	}
	defer func() {
		if ce := c.forceKill(ctx, w); ce != nil && err == nil {
			err = ce
		}
	}()
	if e = c.health(ctx, 60*time.Second); e != nil {
		return e
	}
	if e = c.probe(ctx); e != nil {
		return e
	}
	if e = c.gracefulStop(ctx, w); e != nil {
		return e
	}
	return c.portReleased(ctx)
}

func (c *controller) recordScenario(ctx *executionContext, name string, v object) error {
	v["profile_id"] = issuedID
	v["pass"] = true
	return c.writeEvidence(ctx, name, v, false)
}

func (c *controller) terminalFailure(ctx *executionContext, scenario string, cause error, recovery object) error {
	_ = c.event(ctx, scenario, "terminal_failure", object{
		"failure_code": codeOf(cause),
		"recovery":     recovery,
	})
	return faild("PROFILE_FAILED_TERMINAL", codeOf(cause))
}

func (c *controller) recoverUpgradeFailure(ctx *executionContext, cause error) error {
	if e := c.cleanupProcesses(ctx); e != nil {
		return fmt.Errorf("%w; cleanup=%v", cause, e)
	}
	if !c.sys.portFree() {
		return fail("POST_ACTIVATION_FAILURE_RECOVERY_CANNOT_RESTORE_LAST_VERIFIED_REVISION")
	}
	if _, e := c.verifySlot(slotRootFor(c.paths, revisionA), ctx.deadline); e != nil {
		return fail("POST_ACTIVATION_FAILURE_RECOVERY_CANNOT_RESTORE_LAST_VERIFIED_REVISION")
	}
	if _, e := c.publishCurrent(ctx, upgradeRecovery()); e != nil {
		return fail("POST_ACTIVATION_FAILURE_RECOVERY_CANNOT_RESTORE_LAST_VERIFIED_REVISION")
	}
	if e := c.requireCurrentRevision(ctx, revisionA); e != nil {
		return fail("POST_ACTIVATION_FAILURE_RECOVERY_CANNOT_RESTORE_LAST_VERIFIED_REVISION")
	}
	_ = c.writeEvidence(ctx, "M1RuntimeLifecycleUpgrade.json", object{
		"profile_id": issuedID,
		"pass":       false,
		"failure_code": codeOf(cause),
		"recovery_transition_index": json.Number("3"),
		"recovery_to": revisionA,
		"terminal_after_recovery": true,
	}, false)
	return c.terminalFailure(ctx, "M1-08-PC-UPGRADE-001", cause, object{
		"transition_index": json.Number("3"), "to": revisionA, "recovery_of_transition_index": json.Number("2"),
	})
}

func (c *controller) recoverRollbackFailure(ctx *executionContext, cause error) error {
	if e := c.cleanupProcesses(ctx); e != nil {
		return fmt.Errorf("%w; cleanup=%v", cause, e)
	}
	if !c.sys.portFree() {
		return fail("POST_ACTIVATION_FAILURE_RECOVERY_CANNOT_RESTORE_LAST_VERIFIED_REVISION")
	}
	if _, e := c.verifySlot(slotRootFor(c.paths, revisionB), ctx.deadline); e != nil {
		return fail("POST_ACTIVATION_FAILURE_RECOVERY_CANNOT_RESTORE_LAST_VERIFIED_REVISION")
	}
	if _, e := c.publishCurrent(ctx, rollbackRecovery()); e != nil {
		return fail("POST_ACTIVATION_FAILURE_RECOVERY_CANNOT_RESTORE_LAST_VERIFIED_REVISION")
	}
	if e := c.requireCurrentRevision(ctx, revisionB); e != nil {
		return fail("POST_ACTIVATION_FAILURE_RECOVERY_CANNOT_RESTORE_LAST_VERIFIED_REVISION")
	}
	_ = c.writeEvidence(ctx, "M1RuntimeLifecycleRollback.json", object{
		"profile_id": issuedID,
		"pass":       false,
		"failure_code": codeOf(cause),
		"recovery_transition_index": json.Number("4"),
		"recovery_to": revisionB,
		"terminal_after_recovery": true,
	}, false)
	return c.terminalFailure(ctx, "M1-08-PC-ROLLBACK-001", cause, object{
		"transition_index": json.Number("4"), "to": revisionB, "recovery_of_transition_index": json.Number("3"),
	})
}

func (c *controller) run(ctx *executionContext) (err error) {
	if e := c.limits(ctx); e != nil {
		return e
	}
	defer func() {
		if ce := c.cleanupProcesses(ctx); ce != nil && err == nil {
			err = ce
		}
	}()

	pre, e := c.attestSource(ctx.deadline)
	if e != nil {
		return e
	}
	if e = c.writeEvidence(ctx, "M1RuntimeLifecyclePreflight.json", object{
		"profile_id":                    issuedID,
		"contract_git_blob_sha1":        contractBlobSHA1,
		"physical_identity_sha256":      ctx.physical,
		"native_source_manifest_sha256": c.trust.sourceDigest,
		"native_binary_sha256":          c.trust.binaryDigest,
		"source_model_sha256":           pre.modelSHA,
		"source_runtime_asset_sha256":   pre.assetSHA,
		"source_runtime_tree_sha256":    pre.treeSHA,
		"source_runtime_tree_files":     json.Number(strconvFormatInt(int64(pre.treeFiles))),
	}, false); e != nil {
		return e
	}

	a, e := c.materializeSlot(ctx, revisionA)
	if e != nil {
		return e
	}
	if _, e = c.publishCurrent(ctx, successTransition(1)); e != nil {
		return e
	}
	if e = c.probeActiveSlot(ctx, revisionA, "M1-08-PC-INSTALL-001", "install-a"); e != nil {
		if ce := c.cleanupProcesses(ctx); ce != nil {
			return fmt.Errorf("%w; cleanup=%v", e, ce)
		}
		if !c.sys.portFree() {
			return e
		}
		_ = c.removeUnverifiedInitialCurrent(ctx)
		_ = c.writeEvidence(ctx, "M1RuntimeLifecycleInstall.json", object{"profile_id": issuedID, "pass": false, "failure_code": codeOf(e)}, false)
		return c.terminalFailure(ctx, "M1-08-PC-INSTALL-001", e, object{"recovery": "NONE / INITIAL A NOT VERIFIED"})
	}
	if e = c.recordScenario(ctx, "M1RuntimeLifecycleInstall.json", object{
		"revision_id": revisionA, "slot_manifest_sha256": a.manifestSHA, "transition_index": json.Number("1"), "probe": "PASS",
	}); e != nil {
		return e
	}

	b, e := c.materializeSlot(ctx, revisionB)
	if e != nil {
		return e
	}
	if _, e = c.publishCurrent(ctx, successTransition(2)); e != nil {
		return e
	}
	if e = c.probeActiveSlot(ctx, revisionB, "M1-08-PC-UPGRADE-001", "upgrade-b"); e != nil {
		return c.recoverUpgradeFailure(ctx, e)
	}
	if e = c.recordScenario(ctx, "M1RuntimeLifecycleUpgrade.json", object{
		"from": revisionA, "to": revisionB, "slot_manifest_sha256": b.manifestSHA, "transition_index": json.Number("2"), "probe": "PASS", "binary_version_migration_claim": false,
	}); e != nil {
		return e
	}

	a2, e := c.verifySlot(slotRootFor(c.paths, revisionA), ctx.deadline)
	if e != nil {
		return e
	}
	if a2.manifestSHA != a.manifestSHA {
		return fail("ROLLBACK_TARGET_A_IDENTITY_DRIFT")
	}
	if _, e = c.publishCurrent(ctx, successTransition(3)); e != nil {
		return e
	}
	if e = c.probeActiveSlot(ctx, revisionA, "M1-08-PC-ROLLBACK-001", "rollback-a"); e != nil {
		return c.recoverRollbackFailure(ctx, e)
	}
	if e = c.recordScenario(ctx, "M1RuntimeLifecycleRollback.json", object{
		"from": revisionB, "to": revisionA, "slot_manifest_sha256": a.manifestSHA, "transition_index": json.Number("3"), "probe": "PASS",
	}); e != nil {
		return e
	}

	post, e := c.attestSource(ctx.deadline)
	if e != nil {
		return e
	}
	if pre.modelSHA != post.modelSHA || pre.assetSHA != post.assetSHA || pre.treeSHA != post.treeSHA || pre.treeFiles != post.treeFiles {
		return fail("UNEXPECTED_SOURCE_PACKAGE_MUTATION")
	}
	if e = c.writeEvidence(ctx, "M1RuntimeLifecycleDigests.json", object{
		"profile_id": issuedID,
		"source_model_sha256_pre": pre.modelSHA, "source_model_sha256_post": post.modelSHA,
		"source_runtime_asset_sha256_pre": pre.assetSHA, "source_runtime_asset_sha256_post": post.assetSHA,
		"source_runtime_tree_sha256_pre": pre.treeSHA, "source_runtime_tree_sha256_post": post.treeSHA,
		"whole_package_root_unchanged_claim": false,
	}, false); e != nil {
		return e
	}

	if e = c.cleanupProcesses(ctx); e != nil {
		return e
	}
	if !c.sys.portFree() {
		return fail("ORPHAN_PROFILE_OWNED_SERVER_AFTER_CLEANUP")
	}
	if e = c.removeRuntimeRootSuccess(ctx); e != nil {
		return e
	}
	if _, e = os.Stat(c.paths.testRoot); !os.IsNotExist(e) {
		return fail("FINAL_TEST_RUNTIME_STATE_NOT_REMOVED")
	}
	if _, e = os.Stat(c.paths.guard); e != nil {
		return fail("PERSISTENT_ATTEMPT_GUARD_MISSING_AFTER_CLEANUP")
	}
	if _, e = os.Stat(c.paths.evidence); e != nil {
		return fail("PERSISTENT_EVIDENCE_MISSING_AFTER_CLEANUP")
	}
	if e = c.writeEvidence(ctx, "M1RuntimeLifecycleCleanup.json", object{
		"profile_id": issuedID, "runtime_test_root_removed": true, "attempt_guard_retained": true, "evidence_retained": true, "port_18088_free": true,
	}, false); e != nil {
		return e
	}
	if e = c.writeEvidence(ctx, "M1RuntimeLifecycleCloseout.json", object{
		"profile_id": issuedID, "pass": true, "server_starts": json.Number(strconvFormatInt(int64(ctx.starts))), "binary_version_migration_claim": false,
		"install": "PASS", "upgrade": "PASS", "rollback": "PASS", "cleanup": "PASS",
	}, false); e != nil {
		return e
	}
	return c.limits(ctx)
}
