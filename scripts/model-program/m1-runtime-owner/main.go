package main

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

func readBounded(path string) ([]byte, error) {
	f, e := os.Open(path)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	b, e := io.ReadAll(io.LimitReader(f, (1<<20)+1))
	if len(b) > 1<<20 {
		return nil, fail("PROFILE_ENCODING_OR_SIZE")
	}
	return b, e
}
func binarySHA() (string, error) {
	path, e := os.Executable()
	if e != nil {
		return "", e
	}
	f, e := os.Open(path)
	if e != nil {
		return "", e
	}
	defer f.Close()
	b, e := io.ReadAll(io.LimitReader(f, 64<<20))
	if e != nil {
		return "", e
	}
	return sha(b), nil
}

// Exact fixed schema, never accept a PID/process/wrapper/callback/registry,
// python module, native library, arbitrary server command or test flag.
func parseLaunch(args []string) (execute bool, profile, output string, err error) {
	if len(args) == 0 || !filepath.IsAbs(args[0]) {
		return false, "", "", fail("OWNER_ABSOLUTE_EXECUTABLE_REQUIRED")
	}
	switch {
	case len(args) == 1:
		return false, "", "", nil
	case len(args) == 4 && args[1] == "--validate-only" && args[2] == "--profile":
		profile = args[3]
	case len(args) == 6 && args[1] == "--execute" && args[2] == "--profile" && args[4] == "--output-dir":
		execute = true
		profile = args[3]
		output = args[5]
	default:
		return false, "", "", fail("OWNER_FIXED_ARGUMENT_SCHEMA_REQUIRED")
	}
	if !filepath.IsAbs(profile) || (execute && !filepath.IsAbs(output)) {
		return false, "", "", fail("OWNER_ABSOLUTE_PATHS_REQUIRED")
	}
	return
}
func runCLI(args []string, stdout, stderr io.Writer) int {
	execute, path, out, e := parseLaunch(args)
	if e != nil {
		fmt.Fprintln(stderr, e)
		return 3
	}
	if path == "" {
		fmt.Fprintln(stdout, string(canonical(object{"profile_id": candidateID, "status": "BLOCKED_PENDING_REVIEW_AND_FINAL_ISSUANCE", "execution_ready": false, "effectful_authority_issued": false, "reason": "PROFILE_NOT_ISSUED", "server_started": false, "model_loaded": false})))
		return 0
	}
	raw, e := readBounded(path)
	if e != nil {
		fmt.Fprintln(stderr, e)
		return 3
	}
	p, e := decodeProfile(raw)
	if e != nil {
		fmt.Fprintln(stderr, e)
		return 3
	}
	e = validateStatic(p, time.Now().UTC())
	if e == nil {
		e = verifySignature(p, issuerPublicKeyHex)
	}
	if !execute {
		reason := "READY_FOR_NATIVE_AUTHORIZATION"
		if e != nil {
			reason = codeOf(e)
		}
		fmt.Fprintln(stdout, string(canonical(object{"profile_id": text(p, "profile_id"), "execution_ready": false, "profile_checks_ready": e == nil, "reason": reason, "server_started": false, "model_loaded": false})))
		return 0
	}
	if e != nil {
		fmt.Fprintln(stderr, "BLOCKED:", codeOf(e))
		return 3
	}
	hash, e := binarySHA()
	if e != nil {
		fmt.Fprintln(stderr, e)
		return 3
	}
	c := newController(realPlatform{}, admission{issuerPublicKeyHex, nativeSourceDigest, hash}, attemptPath)
	ctx, e := c.authorize(p, out)
	if e != nil {
		fmt.Fprintln(stderr, "BLOCKED:", codeOf(e))
		return 3
	}
	if e = c.run(ctx); e != nil {
		fmt.Fprintln(stderr, "FAIL_CLOSED:", e)
		return 1
	}
	fmt.Fprintln(stdout, `{"pass":true,"scope":"M1-07_PC_RUNTIME_STABILITY_EVIDENCE_ONLY"}`)
	return 0
}
func main() { os.Exit(runCLI(os.Args, os.Stdout, os.Stderr)) }
