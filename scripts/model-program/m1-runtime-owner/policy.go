// M1-07 r5: policy checks used only by the compiled standalone owner.
// No shared-library build, Python interpreter, plugin loader or callback input.
package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const candidateID = "M1-STAB-QWEN35-08B-PC-001-CANDIDATE"
const issuedID = "M1-STAB-QWEN35-08B-PC-001-ISSUED"
const authorityEffect = "M1-07_PC_RUNTIME_STABILITY_EXECUTION_ONLY"
const boundaryID = "NATIVE_STANDALONE_OWNER / NO_EMBEDDED_PYTHON / DATA_ONLY_INPUT / NO_PROCESS_IMPORT"
const importSurface = "VALIDATE_ONLY / NO_RUNTIME_REGISTRY / NO_CONTEXT_EXPORT / NO_PROCESS_CONTROL"
const machineSHA = "00b300c3b04e170bc097ac0a69cf39378a61f1bdd3ca15a970e55f2119b65522"
const modelSHA = "799482186ea1c91b63bf4eb2999e034330425745496a95f0bffbfe6300a1064d"
const serverSHA = "085151c9dc45b6b6b74ece45207afd809e68c91e05938bb00532a24e80aaabba"
const packageRoot = `C:\Users\Public\Clued\ModelProgram\M1\packages\Qwen_Qwen3.5-0.8B\m1pkg002`
const modelPath = packageRoot + `\packages\Qwen3.5-0.8B-Q8_0.gguf`
const serverPath = packageRoot + `\runtime\b11033-vulkan\llama-server.exe`
const attemptPath = `C:\Users\Public\Clued\ModelProgram\M1\runtime-state\M1-STAB-QWEN35-08B-PC-001\M1RuntimeStabilityAttemptGuard.json`
const storageLimit int64 = 134217728
const evidenceReserve int64 = 1048576
const maxStarts = 7
const wallLimit = 1800 * time.Second
const baseCommit = "bd80de6beed04a52b74f763baa7c274b5741fb1d"

// Deliberately unbound. r5 never generates, imports or activates an issuance key.
// A separately approved, reviewed successor must pin the trusted public key.
// Runtime JSON, argv and environment cannot supply/override this constant.
const issuerPublicKeyHex = ""

// Set at BUILD time by the exact-source manifest; never read from runtime input.
var nativeSourceDigest = ""

type object = map[string]any

type fault struct {
	Code   string
	Detail string
}

func (e *fault) Error() string { return e.Code + ": " + e.Detail }
func fail(code string) error   { return &fault{code, ""} }
func codeOf(e error) string {
	var f *fault
	if errors.As(e, &f) {
		return f.Code
	}
	return "IO_OR_RUNTIME_FAILURE"
}

// Strict JSON: bounded input, valid UTF-8, no duplicate keys, depth <= 64.
// json.Number preserves the exact integer form used by this qualification.
func decodeProfile(raw []byte) (object, error) {
	if len(raw) > 1<<20 || !utf8.Valid(raw) {
		return nil, fail("PROFILE_ENCODING_OR_SIZE")
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	var read func(int) (any, error)
	read = func(depth int) (any, error) {
		if depth > 64 {
			return nil, fail("PROFILE_NESTING_LIMIT")
		}
		t, e := d.Token()
		if e != nil {
			return nil, e
		}
		delim, ok := t.(json.Delim)
		if !ok {
			return t, nil
		}
		switch delim {
		case '{':
			m := object{}
			for d.More() {
				k, e := d.Token()
				if e != nil {
					return nil, e
				}
				s, ok := k.(string)
				if !ok {
					return nil, fail("PROFILE_KEY")
				}
				if _, exists := m[s]; exists {
					return nil, fail("PROFILE_DUPLICATE_KEY")
				}
				v, e := read(depth + 1)
				if e != nil {
					return nil, e
				}
				m[s] = v
			}
			if _, e = d.Token(); e != nil {
				return nil, e
			}
			return m, nil
		case '[':
			a := []any{}
			for d.More() {
				v, e := read(depth + 1)
				if e != nil {
					return nil, e
				}
				a = append(a, v)
			}
			if _, e = d.Token(); e != nil {
				return nil, e
			}
			return a, nil
		default:
			return nil, fail("PROFILE_JSON")
		}
	}
	v, e := read(0)
	if e != nil {
		return nil, e
	}
	if _, e = d.Token(); e != io.EOF {
		return nil, fail("PROFILE_TRAILING_DATA")
	}
	p, ok := v.(object)
	if !ok {
		return nil, fail("PROFILE_OBJECT_REQUIRED")
	}
	return p, nil
}

// Canonical UTF-8 JSON: sorted keys, compact separators, Python-compatible
// ensure_ascii=False escaping; no HTML or U+2028/U+2029 escaping.
func canonical(v any) []byte {
	var b bytes.Buffer
	var write func(any)
	quote := func(s string) {
		b.WriteByte('"')
		for _, r := range s {
			switch r {
			case '"':
				b.WriteString(`\"`)
			case '\\':
				b.WriteString(`\\`)
			case '\b':
				b.WriteString(`\b`)
			case '\f':
				b.WriteString(`\f`)
			case '\n':
				b.WriteString(`\n`)
			case '\r':
				b.WriteString(`\r`)
			case '\t':
				b.WriteString(`\t`)
			default:
				if r < 32 {
					fmt.Fprintf(&b, `\u%04x`, r)
				} else {
					b.WriteRune(r)
				}
			}
		}
		b.WriteByte('"')
	}
	write = func(x any) {
		switch t := x.(type) {
		case nil:
			b.WriteString("null")
		case bool:
			if t {
				b.WriteString("true")
			} else {
				b.WriteString("false")
			}
		case string:
			quote(t)
		case json.Number:
			b.WriteString(string(t))
		case int:
			b.WriteString(strconv.Itoa(t))
		case int64:
			b.WriteString(strconv.FormatInt(t, 10))
		case object:
			ks := make([]string, 0, len(t))
			for k := range t {
				ks = append(ks, k)
			}
			sort.Strings(ks)
			b.WriteByte('{')
			for i, k := range ks {
				if i > 0 {
					b.WriteByte(',')
				}
				quote(k)
				b.WriteByte(':')
				write(t[k])
			}
			b.WriteByte('}')
		case []any:
			b.WriteByte('[')
			for i, w := range t {
				if i > 0 {
					b.WriteByte(',')
				}
				write(w)
			}
			b.WriteByte(']')
		default:
			panic("unsupported canonical type")
		}
	}
	write(v)
	return b.Bytes()
}
func sha(b []byte) string { v := sha256.Sum256(b); return hex.EncodeToString(v[:]) }
func digest(v any) string { return sha(canonical(v)) }
func copyWithout(m object, key string) object {
	r := object{}
	for k, v := range m {
		if k != key {
			r[k] = v
		}
	}
	return r
}
func get(p object, path string) any {
	var v any = p
	for _, k := range strings.Split(path, "/") {
		m, ok := v.(object)
		if !ok {
			return nil
		}
		v = m[k]
	}
	return v
}
func text(p object, path string) string { s, _ := get(p, path).(string); return s }
func equal(a, b any) bool               { return bytes.Equal(canonical(a), canonical(b)) }
func exact(p object, path string, v any) error {
	if !equal(get(p, path), v) {
		return &fault{"PROFILE_SCOPE_DRIFT", path}
	}
	return nil
}
func utc(s string) (time.Time, error) {
	t, e := time.Parse(time.RFC3339Nano, s)
	if e != nil {
		return t, e
	}
	_, off := t.Zone()
	if off != 0 {
		return t, fail("TIME_NOT_UTC")
	}
	return t, nil
}

// Scope cannot be broadened by a valid signature. These checks precede effects.
func scopePolicy() object {
	return object{
		"task_id": "M1-07", "profile_id": issuedID, "effectful_authority_issued": true, "authority_effect": authorityEffect,
		"code_revision/repository": "tdoljyj/cross-memory-system", "code_revision/base_commit": baseCommit,
		"code_revision/required_script_path":                                  "scripts/model-program/m1_runtime_stability_pc.py",
		"code_revision/required_code_commit":                                  expectedFacadeCommit,
		"code_revision/required_script_git_blob_sha1":                         expectedFacadeBlob,
		"code_revision/required_script_normalized_sha256":                     expectedFacadeSHA,
		"exact_model_ids_and_revisions/stability_subject/variant_id":          "q8_0",
		"exact_model_ids_and_revisions/stability_subject/filename":            "Qwen3.5-0.8B-Q8_0.gguf",
		"exact_model_ids_and_revisions/stability_subject/bytes":               833592320,
		"exact_model_ids_and_revisions/stability_subject/sha256":              modelSHA,
		"exact_model_ids_and_revisions/stability_subject/selection_semantics": "STABILITY_REFERENCE_ONLY / CONTINUITY_SUBJECT / NOT_QUALITY_WINNER / NOT_RELEASE_SELECTION / NOT_TEACHER_SELECTION",
		"runtime_and_device_profile/device_name":                              "DESK-W-591", "runtime_and_device_profile/device_class": "PC",
		"runtime_and_device_profile/machine_identity/source":           "WINDOWS_HKLM_MACHINEGUID",
		"runtime_and_device_profile/machine_identity/canonicalization": "SHA256_UTF8_PREFIX_windows-machineguid_COLON_TRIM_LOWERCASE",
		"runtime_and_device_profile/machine_identity/sha256":           machineSHA,
		"runtime_and_device_profile/runtime_release_tag":               "b11033",
		"runtime_and_device_profile/runtime_commit":                    "8ed1a55efcd7424d2c592f6cbc9f97756db1d74d",
		"runtime_and_device_profile/server_executable":                 "llama-server.exe", "runtime_and_device_profile/server_executable_bytes": 9216,
		"runtime_and_device_profile/server_executable_sha256": serverSHA,
		"runtime_and_device_profile/package_root":             packageRoot, "runtime_and_device_profile/exact_model_path": modelPath,
		"config_revision/server/host": "127.0.0.1", "config_revision/server/port": 18087,
		"config_revision/server/offline": true, "config_revision/server/webui": false,
		"config_revision/server/threads": 2, "config_revision/server/threads_batch": 2,
		"config_revision/server/ctx_size": 2048, "config_revision/server/parallel": 1,
		"config_revision/server/n_gpu_layers": 0, "config_revision/server/device": "none", "config_revision/server/op_offload": false,
		"config_revision/server/external_bind": false, "config_revision/server/external_network": false,
		"max_wall_time": 1800, "max_storage": storageLimit, "max_attempts": 1,
		"max_compute/device": "DESK-W-591", "max_compute/cpu_threads": 2, "max_compute/gpu_layers": 0,
		"max_compute/non_cpu_devices": "NONE", "max_compute/max_parallel_server_processes": 1, "max_compute/max_profile_owned_server_starts": 7,
		"execution_control/attempt_guard_path":      attemptPath,
		"execution_control/attempt_guard_semantics": "ATOMIC_CREATE_ON_FIRST_EFFECTFUL_ATTEMPT / NO_REUSE_AFTER_SUCCESS_OR_FAILURE",
		"execution_control/execution_boundary":      boundaryID, "execution_control/import_surface": importSurface,
	}
}
func validateStatic(p object, now time.Time) error {
	if text(p, "status") != "ISSUED" {
		return fail("PROFILE_NOT_ISSUED")
	}
	paths := scopePolicy()
	ks := make([]string, 0, len(paths))
	for k := range paths {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	for _, k := range ks {
		if e := exact(p, k, paths[k]); e != nil {
			return e
		}
	}
	a, ok := get(p, "owner_final_execution_authorization").(object)
	if !ok || a["present"] != true || text(a, "owner_message") == "" {
		return fail("OWNER_FINAL_EXECUTION_AUTHORIZATION_MISSING")
	}
	if text(a, "authorized_profile_id") != issuedID || text(a, "authorized_authority_effect") != authorityEffect {
		return fail("OWNER_AUTH_SCOPE")
	}
	issued, e := utc(text(a, "issued_at_utc"))
	if e != nil || issued.After(now) {
		return fail("OWNER_FINAL_EXECUTION_AUTHORIZATION_TIME_INVALID")
	}
	ah := digest(copyWithout(a, "sha256"))
	if text(a, "sha256") != ah {
		return fail("OWNER_AUTH_DIGEST_INVALID")
	}
	if text(a, "authorization_id") == "" || text(a, "authorization_id") != text(p, "trusted_execution_bindings/expected_owner_authorization_id") {
		return fail("OWNER_AUTHORIZATION_ID_TRUSTED_BINDING_MISMATCH")
	}
	if ah != text(p, "trusted_execution_bindings/expected_owner_authorization_sha256") {
		return fail("OWNER_AUTHORIZATION_SHA_TRUSTED_BINDING_MISMATCH")
	}
	expiry, e := utc(text(p, "expiry"))
	if e != nil {
		return fail("EXPIRY_INVALID")
	}
	if !now.Before(expiry) {
		return fail("PROFILE_EXPIRED")
	}
	prohibited, ok := get(p, "prohibited_operations").([]any)
	if !ok {
		return fail("PROHIBITED_BOUNDARY")
	}
	for _, required := range []string{"TERMINATE_NON_TEST_OWNED_PROCESS", "M1_08_EXECUTION", "TRAINING", "DISTILLATION", "PROMOTION", "ACTIVATION", "PRODUCTION_DEPLOYMENT"} {
		found := false
		for _, v := range prohibited {
			if v == required {
				found = true
			}
		}
		if !found {
			return fail("PROHIBITED_BOUNDARY")
		}
	}
	return nil
}

// The public key is NOT taken from p. A caller-coedited outer binding is not
// independently trusted. The signature binds ALL profile fields, including
// native executable hash, source-manifest hash, expiry and Owner authorization.
func verifySignature(p object, keyHex string) error {
	key, e := hex.DecodeString(keyHex)
	if e != nil || len(key) != ed25519.PublicKeySize {
		return fail("OWNER_ISSUER_TRUST_ROOT_UNBOUND")
	}
	sig, e := base64.StdEncoding.DecodeString(text(p, "owner_signature/signature_base64"))
	if e != nil {
		return fail("OWNER_SIGNATURE_INVALID")
	}
	if text(p, "owner_signature/algorithm") != "Ed25519-CLUED-CANONICAL-JSON-v1" {
		return fail("OWNER_SIGNATURE_ALGORITHM")
	}
	if !ed25519.Verify(ed25519.PublicKey(key), canonical(copyWithout(p, "owner_signature")), sig) {
		return fail("OWNER_SIGNATURE_INVALID")
	}
	return nil
}
