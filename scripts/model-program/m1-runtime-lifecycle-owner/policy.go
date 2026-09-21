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

const candidateID = "M1-LIFE-QWEN35-08B-PC-003-CANDIDATE"
const issuedID = "M1-LIFE-QWEN35-08B-PC-003-ISSUED"
const authorityEffect = "M1-08_PC_RUNTIME_LIFECYCLE_SMOKE_EXECUTION_ONLY"
const contractBlobSHA1 = "2a11bc4fa3d56d58547e11024cd0bfb5f8ba45e7"
const contractPath = "development/contracts/model-program/m1/governance/M1RuntimeLifecycleSmokeContract.v0.1.2.json"
const repository = "tdoljyj/cross-memory-system"
const implementationBase = "ab234beb9c5143a35a7c4e98e1bc9f65d64c507c"
const machineSHA = "00b300c3b04e170bc097ac0a69cf39378a61f1bdd3ca15a970e55f2119b65522"
const modelSHA = "799482186ea1c91b63bf4eb2999e034330425745496a95f0bffbfe6300a1064d"
const runtimeAssetSHA = "8ca91d4621fcac8799245f01a6467e9c09eba7b8d3be161a382048dc5c839db2"
const serverSHA = "085151c9dc45b6b6b74ece45207afd809e68c91e05938bb00532a24e80aaabba"
const sourcePackageRoot = `C:\Users\Public\Clued\ModelProgram\M1\packages\Qwen_Qwen3.5-0.8B\m1pkg002`
const sourceModelPath = sourcePackageRoot + `\packages\Qwen3.5-0.8B-Q8_0.gguf`
const sourceRuntimeAssetPath = sourcePackageRoot + `\runtime\llama-b11033-bin-win-vulkan-x64.zip`
const sourceRuntimeDir = sourcePackageRoot + `\runtime\b11033-vulkan`
const testRoot = `C:\Users\Public\Clued\ModelProgram\M1\runtime-lifecycle-smoke\M1-LIFE-QWEN35-08B-PC-003`
const tempRoot = testRoot + `\state\temp`
const attemptGuardPath = `C:\Users\Public\Clued\ModelProgram\M1\runtime-state\M1-LIFE-QWEN35-08B-PC-003\M1RuntimeLifecycleAttemptGuard.json`
const guardParentPath = `C:\Users\Public\Clued\ModelProgram\M1\runtime-state\M1-LIFE-QWEN35-08B-PC-003`
const evidenceDir = `C:\Users\Public\Clued\ModelProgram\M1\evidence\M1-LIFE-QWEN35-08B-PC-003`
const evidenceParentPath = `C:\Users\Public\Clued\ModelProgram\M1\evidence`
const runtimeLifecycleParentPath = `C:\Users\Public\Clued\ModelProgram\M1\runtime-lifecycle-smoke`
const pc001GuardPath = `C:\Users\Public\Clued\ModelProgram\M1\runtime-state\M1-LIFE-QWEN35-08B-PC-001\M1RuntimeLifecycleAttemptGuard.json`
const pc001GuardSHA = "9e0b95cf7e8cbb16608c73318b6c39b54dd5c1b2ae26daa63e822420cbce14bb"
const pc002GuardPath = `C:\Users\Public\Clued\ModelProgram\M1\runtime-state\M1-LIFE-QWEN35-08B-PC-002\M1RuntimeLifecycleAttemptGuard.json`
const pc002GuardSHA = "4d6a230560fea05a4488ccd3eab1b3054e8906e0360a947409dd04313e4d7863"
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

func exactArgvSemantics() []any {
	return []any{
		"ABSOLUTE_SLOT_LLAMA_SERVER_EXE",
		"--model ABSOLUTE_ACTIVE_SLOT_Q8_0_MODEL",
		"--offline",
		"--host 127.0.0.1",
		"--port 18088",
		"--no-webui",
		"--threads 2",
		"--threads-batch 2",
		"--ctx-size 2048",
		"--parallel 1",
		"--n-gpu-layers 0",
		"--device none",
		"--no-op-offload",
	}
}

func exactLaunchEnvelopePolicy() object {
	return object{
		"envelope_semantics":                      "IMMUTABLE_PROFILE_DERIVED_LAUNCH_ENVELOPE / CALLER_CANNOT_OVERRIDE_EXECUTABLE_ARGV_ENVIRONMENT_CWD_ENDPOINT_OR_PROCESS_OWNERSHIP",
		"caller_supplied_launch_material_allowed": false,
		"caller_supplied_command_allowed":         false,
		"caller_supplied_process_factory_allowed": false,
		"caller_supplied_callback_allowed":        false,
		"executable": object{
			"source":                  "VERIFIED_ACTIVE_SLOT_ONLY",
			"exact_relative_path":     `payload\runtime\b11033-vulkan\llama-server.exe`,
			"resolution":              "ABSOLUTE_PATH_DERIVED_ONLY_FROM_EXACT_VERIFIED_ACTIVE_SLOT / NO_CALLER_PATH / NO_PATH_SEARCH",
			"sha256":                  serverSHA,
			"caller_override_allowed": false,
		},
		"argv": object{
			"source":                            "PROFILE_BOUND_CONSTANTS_PLUS_ABSOLUTE_VERIFIED_ACTIVE_SLOT_MODEL_PATH_ONLY",
			"exact_semantics":                   exactArgvSemantics(),
			"caller_supplied_args_allowed":      false,
			"caller_override_or_append_allowed": false,
			"dynamic_injection_allowed":         false,
		},
		"child_environment": object{
			"construction":                                      "START_FROM_EMPTY_ENVIRONMENT_MAP / DO_NOT_INHERIT_PARENT_OR_CALLER_ENVIRONMENT / EMIT_ONLY_EXACT_ALLOWLIST",
			"windows_name_comparison":                           "CASE_INSENSITIVE",
			"caller_supplied_environment_map_allowed":           false,
			"caller_environment_override_allowed":               false,
			"callback_or_dynamic_environment_injection_allowed": false,
			"allowed_names_exact":                               []any{"SystemRoot", "WINDIR", "TEMP", "TMP"},
			"system_root_and_windir": object{
				"source":          "TRUSTED_WINDOWS_OS_API_GetWindowsDirectoryW_ONLY",
				"value_semantics": "CANONICAL_ABSOLUTE_WINDOWS_DIRECTORY_RETURNED_BY_OS_API / SET BOTH SystemRoot AND WINDIR FROM THAT RESULT",
				"parent_or_caller_environment_read_allowed": false,
				"caller_value_allowed":                      false,
			},
			"temp_and_tmp": object{
				"exact_value":     tempRoot,
				"value_semantics": "BOTH TEMP AND TMP EQUAL THE EXACT PROFILE_OWNED_TEST_PATH / DIRECTORY MUST REMAIN UNDER EXACT TEST ROOT",
				"parent_or_caller_environment_read_allowed": false,
				"caller_value_allowed":                      false,
			},
			"path_variable": object{
				"allowed":   false,
				"semantics": "PATH MUST BE ABSENT / NEVER INHERIT OR ACCEPT CALLER PATH",
			},
			"forbidden_names_exact": []any{
				"PATH", "PATHEXT", "LLAMA_ARG", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
				"http_proxy", "https_proxy", "all_proxy", "no_proxy", "CUDA_VISIBLE_DEVICES", "CUDA_DEVICE_ORDER",
				"VK_ICD_FILENAMES", "VK_LAYER_PATH", "VULKAN_SDK", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
				"USERPROFILE", "HOMEDRIVE", "HOMEPATH", "PYTHONPATH", "PYTHONHOME", "LD_LIBRARY_PATH",
				"LIB", "LIBPATH", "INCLUDE", "TMPDIR",
			},
			"forbidden_name_prefixes": []any{
				"LLAMA_", "GGML_", "CUDA_", "NVIDIA_", "VK_", "VULKAN_", "HIP_", "ROCR_", "SYCL_", "ONEAPI_", "OMP_", "KMP_",
			},
			"unlisted_variable_policy": "OMIT / FAIL_CLOSED_IF EFFECTFUL OWNER ATTEMPTS TO PROPAGATE OR ADD ANY UNLISTED ENVIRONMENT VARIABLE",
			"semantic_invariant":       "ENVIRONMENT INPUT MUST NOT CHANGE EXECUTABLE_ARGV_DLL_RUNTIME_RESOLUTION_CONFIGURATION_NETWORK_ENDPOINT_CPU_ONLY_DEVICE_SEMANTICS_OR_CWD",
		},
		"dll_and_runtime_resolution": object{
			"semantics":                                  "NO_ENVIRONMENT_OR_CALLER_CONTROL / EXACT ACTIVE SLOT EXECUTABLE DIRECTORY AND EXACT ACTIVE SLOT CWD PLUS TRUSTED WINDOWS SYSTEM DIRECTORIES ONLY",
			"PATH_search_allowed":                        false,
			"caller_dll_directory_allowed":               false,
			"caller_runtime_search_path_allowed":         false,
			"environment_search_path_allowed":            false,
			"caller_preload_or_backend_override_allowed": false,
		},
		"cwd": object{
			"source":                      "VERIFIED_ACTIVE_SLOT_ONLY",
			"exact_relative_path":         `payload\runtime\b11033-vulkan`,
			"resolution":                  "ABSOLUTE_PATH_DERIVED_ONLY_FROM_EXACT_VERIFIED_ACTIVE_SLOT ROOT",
			"caller_supplied_cwd_allowed": false,
			"caller_override_allowed":     false,
		},
		"endpoint": object{
			"bind_host":                "127.0.0.1",
			"bind_port":                json.Number("18088"),
			"probe_path":               "/completion",
			"caller_override_allowed":  false,
			"external_bind_allowed":    false,
			"external_network_allowed": false,
		},
		"process_ownership": object{
			"source":                                      "EFFECTFUL_OWNER_DIRECT_CHILD_CREATE_ONLY",
			"semantics":                                   "ORIGINAL_OS_PROCESS_HANDLE_RETURNED_BY_THE_EXACT_LAUNCH_ONLY / CALLER_CANNOT_SUPPLY_PID_HANDLE_PROCESS_OBJECT_FACTORY_CALLBACK_OR_REPLACEMENT",
			"caller_supplied_pid_allowed":                 false,
			"caller_supplied_handle_allowed":              false,
			"caller_supplied_process_object_allowed":      false,
			"caller_supplied_factory_or_callback_allowed": false,
		},
	}
}

func exactSuccessTransitions() []any {
	return []any{
		object{"transition_index": json.Number("1"), "from": nil, "to": revisionA, "transition_kind": "NORMAL", "recovery_of_transition_index": nil},
		object{"transition_index": json.Number("2"), "from": revisionA, "to": revisionB, "transition_kind": "NORMAL", "recovery_of_transition_index": nil},
		object{"transition_index": json.Number("3"), "from": revisionB, "to": revisionA, "transition_kind": "NORMAL", "recovery_of_transition_index": nil},
	}
}

func exactRecoveryTransitions() []any {
	return []any{
		object{
			"trigger":          "UPGRADE_B_ACTIVATED_BUT_PROBE_FAILED",
			"transition_index": json.Number("3"), "from": revisionB, "to": revisionA,
			"transition_kind": "RECOVERY", "recovery_of_transition_index": json.Number("2"),
			"required_reverification": "M1-LIFE-A_EXACT",
			"terminal_after_publish":  "PROFILE_FAILED / NO_FURTHER_TRANSITIONS",
		},
		object{
			"trigger":          "ROLLBACK_A_ACTIVATED_BUT_PROBE_FAILED",
			"transition_index": json.Number("4"), "from": revisionA, "to": revisionB,
			"transition_kind": "RECOVERY", "recovery_of_transition_index": json.Number("3"),
			"required_reverification": "M1-LIFE-B_EXACT",
			"terminal_after_publish":  "PROFILE_FAILED / NO_FURTHER_TRANSITIONS",
		},
	}
}

func scopePolicy() object {
	return object{
		"task_id":                    "M1-08",
		"profile_id":                 issuedID,
		"effectful_authority_issued": true,
		"authority_effect":           authorityEffect,
		"authority_and_sources/lifecycle_contract_git_blob_sha1":                      contractBlobSHA1,
		"code_revision/repository":                                                    repository,
		"code_revision/lifecycle_contract_path":                                       contractPath,
		"code_revision/lifecycle_contract_git_blob_sha1":                              contractBlobSHA1,
		"runtime_and_device_profile/device_name":                                      "DESK-W-591",
		"runtime_and_device_profile/device_class":                                     "PC",
		"runtime_and_device_profile/machine_identity/source":                          "WINDOWS_HKLM_MACHINEGUID",
		"runtime_and_device_profile/machine_identity/canonicalization":                "SHA256_UTF8_PREFIX_windows-machineguid_COLON_TRIM_LOWERCASE",
		"runtime_and_device_profile/machine_identity/sha256":                          machineSHA,
		"runtime_and_device_profile/runtime_release_tag":                              "b11033",
		"runtime_and_device_profile/runtime_commit":                                   "8ed1a55efcd7424d2c592f6cbc9f97756db1d74d",
		"runtime_and_device_profile/runtime_asset_name":                               "llama-b11033-bin-win-vulkan-x64.zip",
		"runtime_and_device_profile/runtime_asset_bytes":                              json.Number(strconv.FormatInt(runtimeAssetBytes, 10)),
		"runtime_and_device_profile/runtime_asset_sha256":                             runtimeAssetSHA,
		"runtime_and_device_profile/server_executable":                                "llama-server.exe",
		"runtime_and_device_profile/server_executable_bytes":                          json.Number(strconv.FormatInt(serverBytes, 10)),
		"runtime_and_device_profile/server_executable_sha256":                         serverSHA,
		"runtime_and_device_profile/source_package_root":                              sourcePackageRoot,
		"runtime_and_device_profile/exact_model_path":                                 sourceModelPath,
		"exact_model_ids_and_revisions/lifecycle_subject/variant_id":                  "q8_0",
		"exact_model_ids_and_revisions/lifecycle_subject/filename":                    "Qwen3.5-0.8B-Q8_0.gguf",
		"exact_model_ids_and_revisions/lifecycle_subject/bytes":                       json.Number(strconv.FormatInt(modelBytes, 10)),
		"exact_model_ids_and_revisions/lifecycle_subject/sha256":                      modelSHA,
		"lifecycle_revision_binding/test_root":                                        testRoot,
		"lifecycle_revision_binding/persistent_attempt_guard_path":                    attemptGuardPath,
		"lifecycle_revision_binding/persistent_evidence_output_dir":                   evidenceDir,
		"lifecycle_revision_binding/guard_parent_path":                                guardParentPath,
		"lifecycle_revision_binding/source_package_mutation_allowed":                  false,
		"lifecycle_revision_binding/binary_version_migration_claim_allowed":           false,
		"lifecycle_revision_binding/revision_A/revision_id":                           revisionA,
		"lifecycle_revision_binding/revision_A/role":                                  "INSTALL_BASELINE_AND_ROLLBACK_TARGET",
		"lifecycle_revision_binding/revision_A/model_sha256":                          modelSHA,
		"lifecycle_revision_binding/revision_A/runtime_asset_sha256":                  runtimeAssetSHA,
		"lifecycle_revision_binding/revision_B/revision_id":                           revisionB,
		"lifecycle_revision_binding/revision_B/role":                                  "UPGRADE_TARGET",
		"lifecycle_revision_binding/revision_B/predecessor_revision_id":               revisionA,
		"lifecycle_revision_binding/revision_B/model_sha256":                          modelSHA,
		"lifecycle_revision_binding/revision_B/runtime_asset_sha256":                  runtimeAssetSHA,
		"lifecycle_revision_binding/guard_parent_must_preexist_before_final_issuance": true,
		"lifecycle_revision_binding/guard_parent_creation_authorized_by_profile":      false,
		"config_revision/server_probe/host":                                           "127.0.0.1",
		"config_revision/server_probe/port":                                           json.Number("18088"),
		"config_revision/server_probe/offline":                                        true,
		"config_revision/server_probe/webui":                                          false,
		"config_revision/server_probe/threads":                                        json.Number("2"),
		"config_revision/server_probe/threads_batch":                                  json.Number("2"),
		"config_revision/server_probe/ctx_size":                                       json.Number("2048"),
		"config_revision/server_probe/parallel":                                       json.Number("1"),
		"config_revision/server_probe/n_gpu_layers":                                   json.Number("0"),
		"config_revision/server_probe/device":                                         "none",
		"config_revision/server_probe/op_offload":                                     false,
		"config_revision/server_probe/external_bind":                                  false,
		"config_revision/server_probe/external_network":                               false,
		"config_revision/server_probe/max_server_starts":                              json.Number("3"),
		"config_revision/server_probe/exact_server_argv_semantics":                    exactArgvSemantics(),
		"config_revision/server_probe/configuration_sources":                          "PROFILE_BOUND_ARGV_AND_EXACT_LAUNCH_ENVELOPE_ONLY / CHILD_ENV_REBUILT_FROM_EMPTY_EXACT_ALLOWLIST / NO_LLAMA_ARG / NO_PROGRAMDATA_APPDATA_CONFIG / NO_CALLER_OR_PARENT_ENVIRONMENT_INHERITANCE",
		"config_revision/server_probe/launch_envelope":                                exactLaunchEnvelopePolicy(),
		"config_revision/lifecycle/current_manifest_relative_path":                    `state\current.json`,
		"config_revision/lifecycle/current_temp_paths": object{
			"1": `state\current.transition-1.tmp`, "2": `state\current.transition-2.tmp`,
			"3": `state\current.transition-3.tmp`, "4": `state\current.transition-4.tmp`,
		},
		"config_revision/lifecycle/activation_atomicity":             "SAME_VOLUME_ATOMIC_REPLACE",
		"config_revision/lifecycle/partial_slot_activation_allowed":  false,
		"config_revision/lifecycle/system_path_mutation_allowed":     false,
		"config_revision/lifecycle/registry_mutation_allowed":        false,
		"config_revision/lifecycle/windows_service_mutation_allowed": false,
		"config_revision/lifecycle/firewall_mutation_allowed":        false,
		"config_revision/lifecycle/attempt_guard_location":           "EXACT_PERSISTENT_RUNTIME_STATE_PATH_OUTSIDE_TEST_ROOT",
		"config_revision/lifecycle/guard_parent_precondition":        "PREEXISTING_VERIFIED_REAL_NON_REPARSE_DIRECTORY / PROFILE_MUST_NOT_CREATE_OR_RECREATE",
		"config_revision/lifecycle/first_profile_owned_write":        "CREATE_NEW_EXACT_ATTEMPT_GUARD_FILE",
		"max_wall_time":                                                 json.Number("1800"),
		"max_storage":                                                   json.Number(strconv.FormatInt(maxStorage, 10)),
		"max_attempts":                                                  json.Number("1"),
		"max_compute/device":                                            "DESK-W-591",
		"max_compute/cpu_threads":                                       json.Number("2"),
		"max_compute/gpu_layers":                                        json.Number("0"),
		"max_compute/non_cpu_devices":                                   "NONE",
		"max_compute/max_parallel_server_processes":                     json.Number("1"),
		"max_compute/max_profile_owned_server_starts":                   json.Number("3"),
		"max_cost_and_currency/max_cost_microunits":                     json.Number("0"),
		"max_cost_and_currency/currency":                                "USD",
		"execution_control/attempt_guard_path":                          attemptGuardPath,
		"execution_control/current_manifest_path":                       testRoot + `\state\current.json`,
		"execution_control/evidence_output_dir":                         evidenceDir,
		"execution_control/guard_parent_path":                           guardParentPath,
		"execution_control/owner_signature_policy":                      "Ed25519-CLUED-CANONICAL-JSON-v1 / ENTIRE_ISSUED_PROFILE_EXCEPT_owner_signature / PINNED_OWNER_ROOT",
		"execution_control/launch_envelope_semantics":                   "EXACT_EXECUTABLE_ARGV_CHILD_ENVIRONMENT_CWD_LOOPBACK_ENDPOINT_AND_ORIGINAL_OS_PROCESS_HANDLE_FORM_ONE_IMMUTABLE_PROFILE_DERIVED_ENVELOPE / NO_CALLER_OVERRIDE_OR_DYNAMIC_INJECTION",
		"lifecycle_safety_binding/write_root_policy":                    "EXACT_TEST_ROOT + EXACT_PERSISTENT_GUARD_PATH + EXACT_PERSISTENT_EVIDENCE_DIR_ONLY",
		"lifecycle_safety_binding/windows_path_safety":                  "REJECT_REPARSE_POINT_JUNCTION_SYMLINK_MOUNTPOINT_ON_EFFECTFUL_WRITE_ANCESTRY_AND_CREATED_TREE / NO_CALLER_SUPPLIED_PATHS / NO_CALLER_SUPPLIED_UNC_DEVICE_NAMESPACE_OR ADS PATHS",
		"lifecycle_safety_binding/recursive_cleanup":                    "NEVER_FOLLOW_REPARSE_POINTS / ABORT_ON_UNEXPECTED_ENTRY_OR_PATH_ESCAPE",
		"lifecycle_safety_binding/current_publish":                      "EXACT SAME-DIRECTORY TEMP PATH PER TRANSITION INDEX / CREATE_NEW + CANONICAL JSON + FLUSH + REOPEN HASH VERIFY + ONE NATIVE SAME-VOLUME RENAME_OR_REPLACE / NEVER DELETE CURRENT THEN RENAME / NO CALLER-CONTROLLED TEMP NAME",
		"lifecycle_safety_binding/transition_sequence":                  exactSuccessTransitions(),
		"lifecycle_safety_binding/failure_recovery_transition_sequence": exactRecoveryTransitions(),
		"lifecycle_safety_binding/transition_branch_rule":               "ONLY THREE BRANCHES ARE LEGAL: SUCCESS=1N,2N,3N; UPGRADE_FAILURE=1N,2N,3R(link=2) THEN TERMINAL FAILURE; ROLLBACK_FAILURE=1N,2N,3N,4R(link=3) THEN TERMINAL FAILURE. NO OTHER INDEX/KIND/LINKAGE.",
		"lifecycle_safety_binding/ntfs_stream_policy":                   "ENUMERATE STREAMS FOR EVERY BOUND SOURCE AND MATERIALIZED SLOT REGULAR FILE / ONLY UNNAMED DEFAULT ::$DATA ALLOWED / ANY NAMED STREAM INCLUDING Zone.Identifier FAILS CLOSED / COPY ONLY DEFAULT STREAM OR USE EXPLICIT SKIP-ALTERNATE-STREAMS SEMANTICS",
		"lifecycle_safety_binding/attempt_guard_bootstrap":              "EXACT GUARD PARENT MUST PREEXIST BEFORE FINAL ISSUANCE / PROFILE CANNOT CREATE OR RECREATE IT / PROVISIONING REQUIRES SEPARATELY REVIEWED OWNER-AUTHORIZED PREPARATION EVIDENCE / FIRST PROFILE-OWNED WRITE IS CREATE_NEW OF GUARD FILE",
		"lifecycle_safety_binding/child_launch_cwd":                     `EXACT VERIFIED ACTIVE SLOT payload\runtime\b11033-vulkan ABSOLUTE DIRECTORY ONLY / NO CALLER CONTROL`,
		"lifecycle_safety_binding/child_launch_environment":             `EMPTY_BASE_ENVIRONMENT / EXACT ALLOWLIST SystemRoot,WINDIR,TEMP,TMP ONLY / SystemRoot+WINDIR FROM TRUSTED GetWindowsDirectoryW / TEMP+TMP=C:\Users\Public\Clued\ModelProgram\M1\runtime-lifecycle-smoke\M1-LIFE-QWEN35-08B-PC-003\state\temp / PATH ABSENT / ALL OTHER VARIABLES OMITTED / NO CALLER OR PARENT INHERITANCE`,
		"lifecycle_safety_binding/child_launch_envelope":                "EXECUTABLE + ARGV + ENVIRONMENT + CWD + 127.0.0.1:18088 ENDPOINT + ORIGINAL OS PROCESS HANDLE ARE JOINTLY IMMUTABLE AND PROFILE-DERIVED",
		"release_ceiling":                                               "M1_08_PC_RUNTIME_LIFECYCLE_SMOKE_EVIDENCE_ONLY / LIFECYCLE_MECHANICS_ONLY / NO_BINARY_MIGRATION_CLAIM / NO_M1_09 / NO_TRAINING / NO_PROMOTION / NO_MODEL_PROMOTION_OR_RELEASE_ACTIVATION / NO_RELEASE / NO_PRODUCTION",
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
	gpi, ok := get(p, "trusted_execution_bindings/guard_parent_provisioning_identity").(object)
	if !ok ||
		text(gpi, "canonical_path") != guardParentPath ||
		!strings.EqualFold(text(gpi, "filesystem_type"), "NTFS") ||
		!isHex(text(gpi, "volume_serial"), 8) ||
		!isHex(text(gpi, "file_id"), 16) ||
		!strings.HasPrefix(strings.ToUpper(text(gpi, "owner_sid")), "S-") ||
		!isHex(text(gpi, "security_descriptor_sha256"), 64) ||
		gpi["empty_parent"] != true ||
		gpi["non_reparse"] != true {
		return fail("GUARD_PARENT_PROVISIONING_IDENTITY_UNBOUND")
	}
	parentBindings := []struct {
		evidencePath string
		identityPath string
		exactPath    string
	}{
		{"trusted_execution_bindings/evidence_parent_provisioning_evidence_sha256", "trusted_execution_bindings/evidence_parent_provisioning_identity", evidenceParentPath},
		{"trusted_execution_bindings/runtime_lifecycle_parent_provisioning_evidence_sha256", "trusted_execution_bindings/runtime_lifecycle_parent_provisioning_identity", runtimeLifecycleParentPath},
	}
	for _, binding := range parentBindings {
		if !isHex(text(p, binding.evidencePath), 64) {
			return fail("EXECUTION_PARENT_PROVISIONING_EVIDENCE_UNBOUND")
		}
		id, ok := get(p, binding.identityPath).(object)
		if !ok || text(id, "canonical_path") != binding.exactPath ||
			!strings.EqualFold(text(id, "filesystem_type"), "NTFS") ||
			!isHex(text(id, "volume_serial"), 8) || !isHex(text(id, "file_id"), 16) ||
			!strings.HasPrefix(strings.ToUpper(text(id, "owner_sid")), "S-") ||
			!isHex(text(id, "security_descriptor_sha256"), 64) || id["non_reparse"] != true {
			return fail("EXECUTION_PARENT_PROVISIONING_IDENTITY_UNBOUND")
		}
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
