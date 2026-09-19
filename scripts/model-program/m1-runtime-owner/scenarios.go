package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

// All HTTP is fixed loopback, no proxy, no redirects, no URL supplied by caller.
func (c *controller) request(ctx *executionContext, method, path string, payload object, timeout time.Duration) (*http.Response, context.CancelFunc, error) {
	if e := c.limits(ctx); e != nil {
		return nil, nil, e
	}
	end := c.now().Add(timeout)
	if ctx.deadline.Before(end) {
		end = ctx.deadline
	}
	requestCtx, cancel := context.WithDeadline(context.Background(), end)
	var body io.Reader
	if payload != nil {
		body = bytes.NewReader(canonical(payload))
	}
	req, e := http.NewRequestWithContext(requestCtx, method, "http://127.0.0.1:18087"+path, body)
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
	cleanup := func() { cancel(); resp.Body.Close() }
	return resp, cleanup, nil
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
		if e := c.limits(ctx); e != nil {
			return e
		}
		resp, close, e := c.request(ctx, "GET", "/health", nil, 2*time.Second)
		if e == nil {
			status := resp.StatusCode
			close()
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
	resp, close, e := c.request(ctx, "POST", "/completion", object{"prompt": "Reply with exactly: OK", "n_predict": 8, "temperature": 0, "stream": false}, 30*time.Second)
	if e != nil {
		return e
	}
	defer close()
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
	var result any
	if e = json.Unmarshal(raw, &result); e != nil {
		return e
	}
	return c.limits(ctx)
}
func (c *controller) stream(ctx *executionContext) (context.CancelFunc, error) {
	resp, close, e := c.request(ctx, "POST", "/completion", object{"prompt": "Count upward from 1 and keep going with one number per token.", "n_predict": 512, "temperature": 0, "stream": true}, 30*time.Second)
	if e != nil {
		return nil, e
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		close()
		return nil, fail("STREAM_HTTP_FAILURE")
	}
	// A complete nonempty stream event, not an arbitrary header/first byte.
	scanner := bufio.NewScanner(io.LimitReader(resp.Body, 1<<20))
	scanner.Buffer(make([]byte, 4096), 65536)
	for scanner.Scan() {
		if e = c.limits(ctx); e != nil {
			close()
			return nil, e
		}
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "" {
			continue
		}
		if data == "[DONE]" {
			break
		}
		var v object
		if e = json.Unmarshal([]byte(data), &v); e != nil {
			continue
		}
		if v["stop"] == true {
			break
		}
		if text(v, "content") == "" {
			continue
		}
		return close, nil
	}
	close()
	return nil, fail("STREAM_NO_ACTIVE_EVENT")
}
func portFree() bool {
	l, e := net.Listen("tcp4", "127.0.0.1:18087")
	if e != nil {
		return false
	}
	l.Close()
	return true
}
func (c *controller) portReleased(ctx *executionContext) error {
	end := c.now().Add(10 * time.Second)
	for c.now().Before(end) {
		if e := c.limits(ctx); e != nil {
			return e
		}
		if c.sys.portFree() {
			return nil
		}
		if e := c.sleep(ctx, 100*time.Millisecond); e != nil {
			return e
		}
	}
	return fail("PORT_RELEASE_TIMEOUT")
}
func (c *controller) oneScenario(ctx *executionContext, id, label string, body func(*ownedProcess) error) (err error) {
	if !c.sys.portFree() {
		return fail("PORT_ALREADY_IN_USE")
	}
	w, e := c.startServer(ctx, id, label)
	if e != nil {
		return e
	}
	defer func() {
		if ce := c.safeCleanup(ctx, w); ce != nil && err == nil {
			err = ce
		}
	}()
	start := c.now()
	if e = c.health(ctx, 60*time.Second); e != nil {
		return e
	}
	if e = c.metrics(ctx, w, "ready"); e != nil {
		return e
	}
	if e = c.event(ctx, id, "ready", object{"readiness_milliseconds": int64(c.now().Sub(start) / time.Millisecond)}); e != nil {
		return e
	}
	if e = body(w); e != nil {
		return e
	}
	if e = c.gracefulStop(ctx, w); e != nil {
		return e
	}
	return c.portReleased(ctx)
}

// Production body is a closed, fixed sequence. No scenario/command selection
// or function/callback enters from JSON, argv, stdin, Python or any RPC.
func (c *controller) run(ctx *executionContext) (err error) {
	if e := c.limits(ctx); e != nil {
		return e
	}
	defer func() {
		if ce := c.cleanupAll(ctx); ce != nil && err == nil {
			err = ce
		}
	}()
	if e := c.write(ctx, "M1RuntimeStabilityPreflight.json", object{"profile_id": issuedID, "physical_identity_sha256": ctx.physical, "native_source_sha256": c.trust.sourceDigest, "native_binary_sha256": c.trust.binaryDigest, "model_sha256": modelSHA, "server_sha256": serverSHA}, false, false); e != nil {
		return e
	}
	for i := 1; i <= 3; i++ {
		if e := c.oneScenario(ctx, "M1-07-PC-LOAD-001", fmt.Sprintf("load-%02d", i), func(*ownedProcess) error { return c.probe(ctx) }); e != nil {
			return e
		}
	}
	if e := c.write(ctx, "M1RuntimeStabilityLoad.json", object{"cycles": 3, "pass": true}, false, false); e != nil {
		return e
	}
	if e := c.oneScenario(ctx, "M1-07-PC-CANCEL-001", "cancel", func(w *ownedProcess) error {
		close, e := c.stream(ctx)
		if e != nil {
			return e
		}
		close()
		if e = c.event(ctx, "M1-07-PC-CANCEL-001", "client_stream_cancelled", object{}); e != nil {
			return e
		}
		if e = c.sleep(ctx, 500*time.Millisecond); e != nil {
			return e
		}
		alive, e := c.alive(ctx, w)
		if e != nil {
			return e
		}
		if !alive {
			return fail("SERVER_CRASHED_AFTER_CANCEL")
		}
		if e = c.health(ctx, 5*time.Second); e != nil {
			return e
		}
		if e = c.metrics(ctx, w, "post-cancel"); e != nil {
			return e
		}
		return c.probe(ctx)
	}); e != nil {
		return e
	}
	if e := c.write(ctx, "M1RuntimeStabilityCancel.json", object{"pass": true}, false, false); e != nil {
		return e
	}
	if e := c.oneScenario(ctx, "M1-07-PC-BACKGROUND-001", "background", func(w *ownedProcess) error {
		if e := c.event(ctx, "M1-07-PC-BACKGROUND-001", "controller_disconnected", object{}); e != nil {
			return e
		}
		if e := c.sleep(ctx, 10*time.Second); e != nil {
			return e
		}
		alive, e := c.alive(ctx, w)
		if e != nil {
			return e
		}
		if !alive {
			return fail("BACKGROUND_SERVER_EXITED")
		}
		if e = c.health(ctx, 5*time.Second); e != nil {
			return e
		}
		if e = c.metrics(ctx, w, "fresh-client-reconnect"); e != nil {
			return e
		}
		if e = c.event(ctx, "M1-07-PC-BACKGROUND-001", "fresh_client_reconnected", object{}); e != nil {
			return e
		}
		return c.probe(ctx)
	}); e != nil {
		return e
	}
	if e := c.write(ctx, "M1RuntimeStabilityBackgroundReconnect.json", object{"pass": true, "semantics": "PC_BACKGROUND_SERVICE_CONTINUITY_ONLY / NOT_MOBILE_APP_BACKGROUND_RESUME"}, false, false); e != nil {
		return e
	}
	if !c.sys.portFree() {
		return fail("PORT_ALREADY_IN_USE")
	}
	w, e := c.startServer(ctx, "M1-07-PC-CRASH-001", "crash-before")
	if e != nil {
		return e
	}
	if e = c.health(ctx, 60*time.Second); e != nil {
		return e
	}
	if e = c.metrics(ctx, w, "pre-crash-ready"); e != nil {
		return e
	}
	close, e := c.stream(ctx)
	if e != nil {
		return e
	}
	if e = c.event(ctx, "M1-07-PC-CRASH-001", "active_stream_observed", object{}); e != nil {
		close()
		return e
	}
	// Required order: active stream -> kill exact owned handle -> close -> port -> restart.
	e = c.forceKill(ctx, w)
	close()
	if e != nil {
		return e
	}
	if e = c.event(ctx, "M1-07-PC-CRASH-001", "forced_crash_during_active_stream", object{}); e != nil {
		return e
	}
	if e = c.portReleased(ctx); e != nil {
		return e
	}
	if e = c.oneScenario(ctx, "M1-07-PC-CRASH-001", "crash-after", func(w *ownedProcess) error {
		if e := c.metrics(ctx, w, "post-restart-ready"); e != nil {
			return e
		}
		return c.probe(ctx)
	}); e != nil {
		return e
	}
	if e = c.write(ctx, "M1RuntimeStabilityCrashRestart.json", object{"pass": true}, false, false); e != nil {
		return e
	}
	if e = c.sys.attestFiles(ctx.deadline); e != nil {
		return e
	}
	if e = c.write(ctx, "M1RuntimeStabilityDigests.json", object{"pass": true, "model_sha256_post": modelSHA, "server_sha256_post": serverSHA}, false, false); e != nil {
		return e
	}
	if e = c.cleanupAll(ctx); e != nil {
		return e
	}
	for _, r := range c.processes {
		if r.ctx == ctx && !r.closed {
			return fail("ORPHAN_PROFILE_OWNED_SERVER_AFTER_CLEANUP")
		}
	}
	if e = c.write(ctx, "M1RuntimeStabilityCloseout.json", object{"profile_id": issuedID, "pass": true, "server_starts": ctx.count, "wall_milliseconds": int64(c.now().Sub(ctx.started) / time.Millisecond), "cleanup_verified": true}, false, false); e != nil {
		return e
	}
	return c.limits(ctx)
}

func (realPlatform) portFree() bool { return portFree() }
func (realPlatform) roundTrip(req *http.Request) (*http.Response, error) {
	tr := &http.Transport{Proxy: nil, DisableKeepAlives: true, DialContext: (&net.Dialer{Timeout: 2 * time.Second}).DialContext, ResponseHeaderTimeout: 30 * time.Second}
	return (&http.Client{Transport: tr, CheckRedirect: func(*http.Request, []*http.Request) error { return fail("HTTP_REDIRECT_FORBIDDEN") }}).Do(req)
}
