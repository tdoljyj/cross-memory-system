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

const candidateID = "M1-LIFE-QWEN35-08B-PC-001-CANDIDATE"
const issuedID = "M1-LIFE-QWEN35-08B-PC-001-ISSUED"
const authorityEffect = "M1-08_PC_RUNTIME_LIFECYCLE_SMOKE_EXECUTION_ONLY"
const contractBlobSHA1 = "f422d4da73deb1cafb6c00468602c8309d896786"
const contractPath = "development/contracts/model-program/m1/governance/M1RuntimeLifecycleSmokeContract.v0.1.json"
const repository = "tdoljyj/cross-memory-system"
const implementationBase = "3d8a4c88373f5a54831b40d34c0ad89281d02ac1"
const machineSHA = "00b300c3b04e170bc097ac0a69cf39378a61f1bdd3ca15a970e55f2119b65522"
const modelSHA = "799482186ea1c91b63bf4eb2999e034330425745496a95f0bffbfe6300a1064d"
const runtimeAssetSHA = "8ca91d4621fcac8799245f01a6467e9c09eba7b8d3be161a382048dc5c839db2"
const serverSHA = "085151c9dc45b6b6b74ece45207afd809e68c91e05938bb00532a24e80aaabba"
const sourcePackageRoot = `C:\Users\Public\Clued\ModelProgram\M1\packages\Qwen_Qwen3.5-0.8B\m1pkg002`
const sourceModelPath = sourcePackageRoot + `\packages\Qwen3.5-0.8B-Q8_0.gguf`
const sourceRuntimeAssetPath = sourcePackageRoot + `\runtime\llama-b11033-bin-win-vulkan-x64.zip`
const sourceRuntimeDir = sourcePackageRoot + `\runtime\b11033-vulkan`
const testRoot = `C:\Users\Public\Clued\ModelProgram\M1\runtime-lifecycle-smoke\M1-LIFE-QWEN35-08B-PC-001`
const tempRoot = testRoot + `\state\temp`
const attemptGuardPath = `C:\Users\Public\Clued\ModelProgram\M1\runtime-state\M1-LIFE-QWEN35-08B-PC-001\M1RuntimeLifecycleAttemptGuard.json`
const guardParentPath = `C:\Users\Public\Clued\ModelProgram\M1\runtime-state\M1-LIFE-QWEN35-08B-PC-001`
const evidenceDir = `C:\Users\Public\Clued\ModelProgram\M1\evidence\M1-LIFE-QWEN35-08B-PC-001`
const modelBytes int64 = 833592320
const runtimeAssetBytes int64 = 31766410
const serverBytes int64 = 9216
const maxStarts = 3
const maxWall = 1800 * time.Second
const maxStorage int64 = 4294967296
const evidenceReserve int64 = 4 << 20

const revisionA = "M1-LIFE-A"
const revisionB = "M1-LIFE-B"

type object = map[string]any

type fault struct {
	Code   string
	Detail string
}

func (f *fault) Error() string {
	if f.Detail == "" {
		return f.Code
	}
	return f.Code + ": " + f.Detail
}
func fail(code string) error          { return &fault{Code: code} }
func faild(code, detail string) error { return &fault{Code: code, Detail: detail} }
func codeOf(err error) string {
	var f *fault
	if errors.As(err, &f) {
		return f.Code
	}
	if err == nil {
		return ""
	}
	return "IO_OR_RUNTIME_FAILURE"
}

func sha(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }
func digest(v any) string { return sha(canonical(v)) }

func decodeObject(raw []byte) (object, error) {
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
		tok, err := d.Token()
		if err != nil {
			return nil, err
		}
		dl, ok := tok.(json.Delim)
		if !ok {
			return tok, nil
		}
		switch dl {
		case '{':
			m := object{}
			for d.More() {
				kt, err := d.Token()
				if err != nil {
					return nil, err
				}
				k, ok := kt.(string)
				if !ok {
					return nil, fail("PROFILE_KEY")
				}
				if _, exists := m[k]; exists {
					return nil, fail("PROFILE_DUPLICATE_KEY")
				}
				v, err := read(depth + 1)
				if err != nil {
					return nil, err
				}
				m[k] = v
			}
			if _, err = d.Token(); err != nil {
				return nil, err
			}
			return m, nil
		case '[':
			a := []any{}
			for d.More() {
				v, err := read(depth + 1)
				if err != nil {
					return nil, err
				}
				a = append(a, v)
			}
			if _, err = d.Token(); err != nil {
				return nil, err
			}
			return a, nil
		default:
			return nil, fail("PROFILE_JSON")
		}
	}
	v, err := read(0)
	if err != nil {
		return nil, err
	}
	if _, err = d.Token(); err != io.EOF {
		return nil, fail("PROFILE_TRAILING_DATA")
	}
	m, ok := v.(object)
	if !ok {
		return nil, fail("PROFILE_OBJECT_REQUIRED")
	}
	return m, nil
}

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
		case float64:
			b.WriteString(strconv.FormatFloat(t, 'f', -1, 64))
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
		case []string:
			b.WriteByte('[')
			for i, w := range t {
				if i > 0 {
					b.WriteByte(',')
				}
				quote(w)
			}
			b.WriteByte(']')
		default:
			panic(fmt.Sprintf("unsupported canonical type %T", x))
		}
	}
	write(v)
	return b.Bytes()
}
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
func exact(p object, path string, want any) error {
	if !equal(get(p, path), want) {
		return faild("PROFILE_SCOPE_DRIFT", path)
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
func isHex(s string, n int) bool {
	if len(s) != n {
		return false
	}
	_, e := hex.DecodeString(s)
	return e == nil
}

func scopePolicy() object {
	return object{
		"task_id":                    "M1-08",
		"profile_id":                 issuedID,
		"effectful_authority_issued": true,
		"authority_effect":           authorityEffect,
		"authority_and_sources/lifecycle_contract_git_blob_sha1":       contractBlobSHA1,
		"code_revision/repository":                                     repository,
		"code_revision/lifecycle_contract_path":                        contractPath,
		"code_revision/lifecycle_contract_git_blob_sha1":               contractBlobSHA1,
		"runtime_and_device_profile/device_name":                       "DESK-W-591",
		"runtime_and_device_profile/device_class":                      "PC",
		"runtime_and_device_profile/machine_identity/source":           "WINDOWS_HKLM_MACHINEGUID",
		"runtime_and_device_profile/machine_identity/canonicalization": "SHA256_UTF8_PREFIX_windows-machineguid_COLON_TRIM_LOWERCASE",
		"runtime_and_device_profile/machine_identity/sha256":           machineSHA,
		"runtime_and_device_profile/runtime_release_tag":               "b11033",
		"runtime_and_device_profile/runtime_commit":                    "8ed1a55efcd7424d2c592f6cbc9f97756db1d74d",
		"runtime_and_device_profile/runtime_asset_name":                "llama-b11033-bin-win-vulkan-x64.zip",
		"runtime_and_device_profile/runtime_asset_bytes":               json.Number(strconv.FormatInt(runtimeAssetBytes, 10)),
		"runtime_and_device_profile/runtime_asset_sha256":              runtimeAssetSHA,
		"runtime_and_device_profile/server_executable":                 "llama-server.exe",
		"runtime_and_device_profile/server_executable_bytes":           json.Number(strconv.FormatInt(serverBytes, 10)),
		"runtime_and_device_profile/server_executable_sha256":          serverSHA,
		"runtime_and_device_profile/source_package_root":               sourcePackageRoot,
		"runtime_and_device_profile/exact_model_path":                  sourceModelPath,
		"exact_model_ids_and_revisions/lifecycle_subject/variant_id":   "q8_0",
		"exact_model_ids_and_revisions/lifecycle_subject/filename":     "Qwen3.5-0.8B-Q8_0.gguf",
		"exact_model_ids_and_revisions/lifecycle_subject/bytes":        json.Number(strconv.FormatInt(modelBytes, 10)),
		"exact_model_ids_and_revisions/lifecycle_subject/sha256":       modelSHA,
		"lifecycle_revision_binding/test_root":                         testRoot,
		"lifecycle_revision_binding/persistent_attempt_guard_path":     attemptGuardPath,
		"lifecycle_revision_binding/persistent_evidence_output_dir":    evidenceDir,
		"lifecycle_revision_binding/guard_parent_path":                 guardParentPath,
		"config_revision/server_probe/host":                            "127.0.0.1",
		"config_revision/server_probe/port":                            json.Number("18088"),
		"config_revision/server_probe/offline":                         true,
		"config_revision/server_probe/webui":                           false,
		"config_revision/server_probe/threads":                         json.Number("2"),
		"config_revision/server_probe/threads_batch":                   json.Number("2"),
		"config_revision/server_probe/ctx_size":                        json.Number("2048"),
		"config_revision/server_probe/parallel":                        json.Number("1"),
		"config_revision/server_probe/n_gpu_layers":                    json.Number("0"),
		"config_revision/server_probe/device":                          "none",
		"config_revision/server_probe/op_offload":                      false,
		"config_revision/server_probe/external_bind":                   false,
		"config_revision/server_probe/external_network":                false,
		"config_revision/server_probe/max_server_starts":               json.Number("3"),
		"config_revision/lifecycle/current_manifest_relative_path":     `state\current.json`,
		"config_revision/lifecycle/attempt_guard_location":             "EXACT_PERSISTENT_RUNTIME_STATE_PATH_OUTSIDE_TEST_ROOT",
		"config_revision/lifecycle/first_profile_owned_write":          "CREATE_NEW_EXACT_ATTEMPT_GUARD_FILE",
		"max_wall_time":                                     json.Number("1800"),
		"max_storage":                                       json.Number(strconv.FormatInt(maxStorage, 10)),
		"max_attempts":                                      json.Number("1"),
		"max_compute/device":                                "DESK-W-591",
		"max_compute/cpu_threads":                           json.Number("2"),
		"max_compute/gpu_layers":                            json.Number("0"),
		"max_compute/non_cpu_devices":                       "NONE",
		"max_compute/max_parallel_server_processes":         json.Number("1"),
		"max_compute/max_profile_owned_server_starts":       json.Number("3"),
		"execution_control/attempt_guard_path":              attemptGuardPath,
		"execution_control/current_manifest_path":           testRoot + `\state\current.json`,
		"execution_control/evidence_output_dir":             evidenceDir,
		"execution_control/guard_parent_path":               guardParentPath,
		"execution_control/owner_signature_policy":          "Ed25519-CLUED-CANONICAL-JSON-v1 / ENTIRE_ISSUED_PROFILE_EXCEPT_owner_signature / PINNED_OWNER_ROOT",
		"lifecycle_safety_binding/child_launch_cwd":         `EXACT VERIFIED ACTIVE SLOT payload\runtime\b11033-vulkan ABSOLUTE DIRECTORY ONLY / NO CALLER CONTROL`,
		"lifecycle_safety_binding/child_launch_environment": `EMPTY_BASE_ENVIRONMENT / EXACT ALLOWLIST SystemRoot,WINDIR,TEMP,TMP ONLY / SystemRoot+WINDIR FROM TRUSTED GetWindowsDirectoryW / TEMP+TMP=C:\Users\Public\Clued\ModelProgram\M1\runtime-lifecycle-smoke\M1-LIFE-QWEN35-08B-PC-001\state\temp / PATH ABSENT / ALL OTHER VARIABLES OMITTED / NO CALLER OR PARENT INHERITANCE`,
	}
}

func validateStatic(p object, now time.Time, publicKeyFingerprint string) error {
	if text(p, "status") != "ISSUED" {
		return fail("PROFILE_NOT_ISSUED")
	}
	ks := make([]string, 0, len(scopePolicy()))
	for k := range scopePolicy() {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	for _, k := range ks {
		if e := exact(p, k, scopePolicy()[k]); e != nil {
			return e
		}
	}
	if publicKeyFingerprint == "" || !isHex(publicKeyFingerprint, 64) {
		return fail("OWNER_ISSUER_TRUST_ROOT_UNBOUND")
	}
	if e := exact(p, "execution_control/issuer_public_key_sha256_fingerprint", publicKeyFingerprint); e != nil {
		return e
	}
	if text(p, "execution_control/issuer_trust_root_status") == "UNRESOLVED_FOR_M1_08 / NO_AUTOMATIC_REUSE_OF_M1_07_ROOT / OWNER_DECISION_REQUIRED_BEFORE_FINAL_ISSUANCE" {
		return fail("OWNER_ISSUER_TRUST_ROOT_UNBOUND")
	}
	src := text(p, "code_revision/required_effectful_owner_source_manifest_sha256")
	if !isHex(src, 64) {
		return fail("NATIVE_SOURCE_BINDING_UNRESOLVED")
	}
	bin := text(p, "code_revision/required_effectful_owner_binary_sha256")
	if !isHex(bin, 64) {
		return fail("NATIVE_BINARY_BINDING_UNRESOLVED")
	}
	if text(p, "code_revision/required_effectful_owner_source_path") != "scripts/model-program/m1-runtime-lifecycle-owner/source-manifest.json" {
		return fail("NATIVE_SOURCE_PATH_DRIFT")
	}
	gp := text(p, "trusted_execution_bindings/guard_parent_provisioning_evidence_sha256")
	if !isHex(gp, 64) {
		return fail("GUARD_PARENT_PROVISIONING_EVIDENCE_UNBOUND")
	}
	auth, ok := get(p, "owner_final_execution_authorization").(object)
	if !ok || auth["present"] != true || text(auth, "owner_message") == "" {
		return fail("OWNER_FINAL_EXECUTION_AUTHORIZATION_MISSING")
	}
	if text(auth, "authorized_profile_id") != issuedID || text(auth, "authorized_authority_effect") != authorityEffect {
		return fail("OWNER_AUTH_SCOPE")
	}
	issued, e := utc(text(auth, "issued_at_utc"))
	if e != nil || issued.After(now) {
		return fail("OWNER_FINAL_EXECUTION_AUTHORIZATION_TIME_INVALID")
	}
	ah := digest(copyWithout(auth, "sha256"))
	if text(auth, "sha256") != ah {
		return fail("OWNER_AUTH_DIGEST_INVALID")
	}
	if text(auth, "authorization_id") == "" || text(auth, "authorization_id") != text(p, "trusted_execution_bindings/expected_owner_authorization_id") {
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
	requiredProhibited := []string{"M1_09_EXECUTION", "TRAINING", "DISTILLATION", "PROMOTION", "MODEL_PROMOTION_OR_RELEASE_ACTIVATION", "RELEASE", "PRODUCTION_DEPLOYMENT", "INHERIT_CALLER_OR_PARENT_CHILD_PROCESS_ENVIRONMENT", "ACCEPT_CALLER_SUPPLIED_ENVIRONMENT_MAP_OVERRIDE_OR_DYNAMIC_INJECTION", "ACCEPT_CALLER_SUPPLIED_EXECUTABLE_ARGV_COMMAND_CWD_ENDPOINT_PROCESS_PID_HANDLE_FACTORY_OR_CALLBACK"}
	arr, ok := get(p, "prohibited_operations").([]any)
	if !ok {
		return fail("PROHIBITED_BOUNDARY")
	}
	for _, req := range requiredProhibited {
		found := false
		for _, v := range arr {
			if v == req {
				found = true
				break
			}
		}
		if !found {
			return faild("PROHIBITED_BOUNDARY", req)
		}
	}
	return nil
}

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
