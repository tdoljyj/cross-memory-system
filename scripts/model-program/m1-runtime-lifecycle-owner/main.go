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
	p, e := os.Executable()
	if e != nil {
		return "", e
	}
	f, e := os.Open(p)
	if e != nil {
		return "", e
	}
	defer f.Close()
	h := newStreamingSHA256()
	buf := make([]byte, 1<<20)
	for {
		n, er := f.Read(buf)
		if n > 0 {
			h.Write(buf[:n])
		}
		if er == io.EOF {
			break
		}
		if er != nil {
			return "", er
		}
	}
	return h.Hex(), nil
}

// Fixed CLI schema. No command, executable, argv, environment, CWD, endpoint,
// PID, handle, process factory, callback, path root or evidence directory is
// accepted from the caller.
func parseLaunch(args []string) (execute bool, profile string, err error) {
	if len(args) == 0 || !filepath.IsAbs(args[0]) {
		return false, "", fail("OWNER_ABSOLUTE_EXECUTABLE_REQUIRED")
	}
	switch {
	case len(args) == 1:
		return false, "", nil
	case len(args) == 4 && args[1] == "--validate-only" && args[2] == "--profile":
		profile = args[3]
	case len(args) == 4 && args[1] == "--execute" && args[2] == "--profile":
		execute = true
		profile = args[3]
	default:
		return false, "", fail("OWNER_FIXED_ARGUMENT_SCHEMA_REQUIRED")
	}
	if !filepath.IsAbs(profile) {
		return false, "", fail("OWNER_ABSOLUTE_PATHS_REQUIRED")
	}
	return execute, profile, nil
}

func runCLI(args []string, stdout, stderr io.Writer) int {
	execute, path, e := parseLaunch(args)
	if e != nil {
		fmt.Fprintln(stderr, e)
		return 3
	}
	if path == "" {
		fmt.Fprintln(stdout, string(canonical(object{"profile_id": candidateID, "status": "IMPLEMENTATION_PREPARATION_CANDIDATE / NO_EFFECTFUL_AUTHORITY", "execution_ready": false, "effectful_authority_issued": false, "issuer_root_bound": issuerPublicKeyHex != "" && issuerPublicKeySHA256 != "", "server_started": false, "model_loaded": false})))
		return 0
	}
	raw, e := readBounded(path)
	if e != nil {
		fmt.Fprintln(stderr, e)
		return 3
	}
	p, e := decodeObject(raw)
	if e != nil {
		fmt.Fprintln(stderr, e)
		return 3
	}
	checkErr := validateStatic(p, time.Now().UTC(), issuerPublicKeySHA256)
	if checkErr == nil {
		checkErr = verifySignature(p, issuerPublicKeyHex)
	}
	if !execute {
		reason := "READY_FOR_NATIVE_AUTHORIZATION"
		if checkErr != nil {
			reason = codeOf(checkErr)
		}
		fmt.Fprintln(stdout, string(canonical(object{"profile_id": text(p, "profile_id"), "execution_ready": false, "profile_checks_ready": checkErr == nil, "reason": reason, "server_started": false, "model_loaded": false})))
		return 0
	}
	if checkErr != nil {
		fmt.Fprintln(stderr, "BLOCKED:", codeOf(checkErr))
		return 3
	}
	bin, e := binarySHA()
	if e != nil {
		fmt.Fprintln(stderr, e)
		return 3
	}
	c := newController(realPlatform{}, admission{publicKey: issuerPublicKeyHex, publicKeyFingerprint: issuerPublicKeySHA256, sourceDigest: nativeSourceDigest, binaryDigest: bin}, productionLayout)
	defer c.closeFilesystem()
	ctx, e := c.authorize(p)
	if e != nil {
		fmt.Fprintln(stderr, "BLOCKED:", e)
		return 3
	}
	if e = c.run(ctx); e != nil {
		fmt.Fprintln(stderr, "FAIL_CLOSED:", e)
		return 1
	}
	fmt.Fprintln(stdout, `{"pass":true,"scope":"M1_08_PC_RUNTIME_LIFECYCLE_SMOKE_EVIDENCE_ONLY"}`)
	return 0
}

func main() { os.Exit(runCLI(os.Args, os.Stdout, os.Stderr)) }
