package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type streamingSHA struct{ h hashWriter }

type hashWriter interface {
	Write([]byte) (int, error)
	Sum([]byte) []byte
}

func newStreamingSHA256() *streamingSHA { return &streamingSHA{h: sha256.New()} }
func (s *streamingSHA) Write(p []byte) (int, error) { return s.h.Write(p) }
func (s *streamingSHA) Hex() string { return hex.EncodeToString(s.h.Sum(nil)) }

type fileSpec struct {
	bytes int64
	sha   string
}

type sourceAttestation struct {
	modelSHA, assetSHA, treeSHA string
	treeFiles                   int
	specs                       map[string]fileSpec
}

type slotAttestation struct {
	revision, manifestSHA, modelSHA, assetSHA, treeSHA string
	treeFiles                                         int
}

type transitionSpec struct {
	index      int
	from, to   string
	kind       string
	recoveryOf any
}

func successTransition(index int) transitionSpec {
	switch index {
	case 1:
		return transitionSpec{index: 1, from: "", to: revisionA, kind: "NORMAL", recoveryOf: nil}
	case 2:
		return transitionSpec{index: 2, from: revisionA, to: revisionB, kind: "NORMAL", recoveryOf: nil}
	case 3:
		return transitionSpec{index: 3, from: revisionB, to: revisionA, kind: "NORMAL", recoveryOf: nil}
	default:
		return transitionSpec{}
	}
}
func upgradeRecovery() transitionSpec {
	return transitionSpec{index: 3, from: revisionB, to: revisionA, kind: "RECOVERY", recoveryOf: json.Number("2")}
}
func rollbackRecovery() transitionSpec {
	return transitionSpec{index: 4, from: revisionA, to: revisionB, kind: "RECOVERY", recoveryOf: json.Number("3")}
}

func samePath(a, b string) bool {
	aa, ea := filepath.Abs(filepath.Clean(a))
	bb, eb := filepath.Abs(filepath.Clean(b))
	if ea != nil || eb != nil {
		return false
	}
	return strings.EqualFold(aa, bb)
}
func withinPath(root, path string) bool {
	r, er := filepath.Abs(filepath.Clean(root))
	p, ep := filepath.Abs(filepath.Clean(path))
	if er != nil || ep != nil {
		return false
	}
	rel, e := filepath.Rel(r, p)
	if e != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel))
}
func hasForbiddenWindowsPathSyntax(path string) bool {
	clean := filepath.Clean(path)
	if strings.HasPrefix(clean, `\\`) || strings.HasPrefix(clean, `\\?\`) || strings.HasPrefix(clean, `\\.\`) {
		return true
	}
	vol := filepath.VolumeName(clean)
	rest := strings.TrimPrefix(clean, vol)
	return strings.Contains(rest, ":")
}
func (c *controller) allowedWritePath(path string) bool {
	if !filepath.IsAbs(path) || hasForbiddenWindowsPathSyntax(path) {
		return false
	}
	if withinPath(c.paths.testRoot, path) || withinPath(c.paths.evidence, path) {
		return true
	}
	return samePath(path, c.paths.guard)
}

func (c *controller) verifyAncestorChain(path string) error {
	p, e := filepath.Abs(filepath.Clean(path))
	if e != nil || !filepath.IsAbs(p) || hasForbiddenWindowsPathSyntax(p) {
		return fail("REPARSE_POINT_OR_PATH_ESCAPE_DETECTED")
	}
	chain := []string{}
	cur := p
	for {
		chain = append(chain, cur)
		parent := filepath.Dir(cur)
		if parent == cur {
			break
		}
		cur = parent
	}
	for i := len(chain) - 1; i >= 0; i-- {
		part := chain[i]
		st, er := os.Lstat(part)
		if os.IsNotExist(er) {
			continue
		}
		if er != nil {
			return er
		}
		if st.Mode()&os.ModeSymlink != 0 {
			return fail("REPARSE_POINT_OR_PATH_ESCAPE_DETECTED")
		}
		rp, er := c.sys.pathIsReparse(part)
		if er != nil {
			return er
		}
		if rp {
			return fail("REPARSE_POINT_OR_PATH_ESCAPE_DETECTED")
		}
		if i != 0 && !st.IsDir() {
			return fail("REPARSE_POINT_OR_PATH_ESCAPE_DETECTED")
		}
	}
	return nil
}
func (c *controller) verifySafeExistingPath(path string) error {
	if e := c.verifyAncestorChain(path); e != nil {
		return e
	}
	st, e := os.Lstat(path)
	if e != nil {
		return e
	}
	if st.Mode()&os.ModeSymlink != 0 {
		return fail("REPARSE_POINT_OR_PATH_ESCAPE_DETECTED")
	}
	rp, e := c.sys.pathIsReparse(path)
	if e != nil {
		return e
	}
	if rp {
		return fail("REPARSE_POINT_OR_PATH_ESCAPE_DETECTED")
	}
	return nil
}
func (c *controller) verifySafeParent(path string) error {
	if !c.allowedWritePath(path) {
		return fail("REPARSE_POINT_OR_PATH_ESCAPE_DETECTED")
	}
	parent := filepath.Dir(filepath.Clean(path))
	st, e := os.Lstat(parent)
	if e != nil || !st.IsDir() {
		if e != nil {
			return e
		}
		return fail("REPARSE_POINT_OR_PATH_ESCAPE_DETECTED")
	}
	return c.verifySafeExistingPath(parent)
}

func (c *controller) verifyNoNamedStreams(path string) error {
	streams, e := c.sys.namedStreams(path)
	if e != nil {
		return e
	}
	for _, s := range streams {
		if !strings.EqualFold(s, "::$DATA") {
			return faild("NAMED_NTFS_ALTERNATE_DATA_STREAM_DETECTED_ON_BOUND_SOURCE_OR_SLOT_FILE", filepath.Base(path)+":"+s)
		}
	}
	if len(streams) != 1 {
		return fail("NAMED_NTFS_ALTERNATE_DATA_STREAM_DETECTED_ON_BOUND_SOURCE_OR_SLOT_FILE")
	}
	return nil
}

func hashFile(path string, deadline time.Time) (string, int64, error) {
	f, e := os.Open(path)
	if e != nil {
		return "", 0, e
	}
	defer f.Close()
	h := sha256.New()
	buf := make([]byte, 1<<20)
	var total int64
	for {
		if !time.Now().Before(deadline) {
			return "", total, fail("MAX_WALL_TIME_EXCEEDED")
		}
		n, er := f.Read(buf)
		if n > 0 {
			total += int64(n)
			_, _ = h.Write(buf[:n])
		}
		if er == io.EOF {
			break
		}
		if er != nil {
			return "", total, er
		}
	}
	return hex.EncodeToString(h.Sum(nil)), total, nil
}
func (c *controller) attestRegular(path string, expectedBytes int64, expectedSHA string, deadline time.Time, writable bool) error {
	if writable && !c.allowedWritePath(path) {
		return fail("REPARSE_POINT_OR_PATH_ESCAPE_DETECTED")
	}
	if e := c.verifySafeExistingPath(path); e != nil {
		return e
	}
	st, e := os.Lstat(path)
	if e != nil {
		return e
	}
	if !st.Mode().IsRegular() || st.Size() != expectedBytes || st.Mode()&os.ModeSymlink != 0 {
		return faild("EXACT_FILE_SIZE_DRIFT", filepath.Base(path))
	}
	if e = c.verifyNoNamedStreams(path); e != nil {
		return e
	}
	if writable {
		links, le := c.sys.hardlinkCount(path)
		if le != nil {
			return le
		}
		if links != 1 {
			return fail("SLOT_HARDLINK_FORBIDDEN")
		}
	}
	got, total, e := hashFile(path, deadline)
	if e != nil {
		return e
	}
	if total != expectedBytes {
		return faild("EXACT_FILE_SIZE_DRIFT", filepath.Base(path))
	}
	if got != expectedSHA {
		return faild("EXACT_FILE_DIGEST_DRIFT", filepath.Base(path))
	}
	return nil
}

func zipSpecs(assetPath string, deadline time.Time) (map[string]fileSpec, string, error) {
	z, e := zip.OpenReader(assetPath)
	if e != nil {
		return nil, "", e
	}
	defer z.Close()
	specs := map[string]fileSpec{}
	tree := sha256.New()
	names := make([]string, 0, len(z.File))
	for _, entry := range z.File {
		if !time.Now().Before(deadline) {
			return nil, "", fail("MAX_WALL_TIME_EXCEEDED")
		}
		name := entry.Name
		if name == "" || entry.FileInfo().IsDir() || filepath.Base(name) != name || strings.ContainsAny(name, `/\`) {
			return nil, "", fail("RUNTIME_TREE_ARCHIVE_PATH_INVALID")
		}
		if _, exists := specs[name]; exists {
			return nil, "", fail("RUNTIME_TREE_DUPLICATE_ENTRY")
		}
		r, er := entry.Open()
		if er != nil {
			return nil, "", er
		}
		h := sha256.New()
		n, er := io.Copy(h, io.LimitReader(r, int64(entry.UncompressedSize64)+1))
		ce := r.Close()
		if er != nil {
			return nil, "", er
		}
		if ce != nil {
			return nil, "", ce
		}
		if n != int64(entry.UncompressedSize64) {
			return nil, "", fail("RUNTIME_TREE_ARCHIVE_SIZE_DRIFT")
		}
		specs[name] = fileSpec{bytes: n, sha: hex.EncodeToString(h.Sum(nil))}
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		s := specs[name]
		_, _ = tree.Write([]byte(name + "\x00" + strconvFormatInt(s.bytes) + "\x00" + s.sha + "\n"))
	}
	return specs, hex.EncodeToString(tree.Sum(nil)), nil
}
func strconvFormatInt(v int64) string {
	if v == 0 {
		return "0"
	}
	neg := v < 0
	if neg {
		v = -v
	}
	var b [32]byte
	i := len(b)
	for v > 0 {
		i--
		b[i] = byte('0' + v%10)
		v /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}

func (c *controller) attestTree(dir string, specs map[string]fileSpec, deadline time.Time, writable bool) error {
	if e := c.verifySafeExistingPath(dir); e != nil {
		return e
	}
	rows, e := os.ReadDir(dir)
	if e != nil {
		return e
	}
	if len(rows) != len(specs) {
		return fail("RUNTIME_TREE_FILE_SET_DRIFT")
	}
	for _, row := range rows {
		if row.IsDir() {
			return fail("RUNTIME_TREE_FILE_SET_DRIFT")
		}
		want, ok := specs[row.Name()]
		if !ok {
			return faild("RUNTIME_TREE_UNEXPECTED_FILE", row.Name())
		}
		if e = c.attestRegular(filepath.Join(dir, row.Name()), want.bytes, want.sha, deadline, writable); e != nil {
			return e
		}
	}
	return nil
}

func (c *controller) attestSource(deadline time.Time) (sourceAttestation, error) {
	if e := c.attestRegular(c.paths.sourceModel, modelBytes, modelSHA, deadline, false); e != nil {
		return sourceAttestation{}, e
	}
	if e := c.attestRegular(c.paths.sourceAsset, runtimeAssetBytes, runtimeAssetSHA, deadline, false); e != nil {
		return sourceAttestation{}, e
	}
	specs, treeSHA, e := zipSpecs(c.paths.sourceAsset, deadline)
	if e != nil {
		return sourceAttestation{}, e
	}
	if e = c.attestTree(c.paths.sourceRuntime, specs, deadline, false); e != nil {
		return sourceAttestation{}, e
	}
	return sourceAttestation{modelSHA: modelSHA, assetSHA: runtimeAssetSHA, treeSHA: treeSHA, treeFiles: len(specs), specs: specs}, nil
}

func (c *controller) createDirExact(path string) error {
	if !c.allowedWritePath(path) {
		return fail("REPARSE_POINT_OR_PATH_ESCAPE_DETECTED")
	}
	if e := c.verifySafeParent(path); e != nil {
		return e
	}
	if e := os.Mkdir(path, 0700); e != nil {
		return e
	}
	return c.verifySafeExistingPath(path)
}

func (c *controller) copyExact(ctx *executionContext, src, dst string, spec fileSpec) error {
	if e := c.limits(ctx); e != nil {
		return e
	}
	if e := c.attestRegular(src, spec.bytes, spec.sha, ctx.deadline, false); e != nil {
		return e
	}
	if e := c.verifySafeParent(dst); e != nil {
		return e
	}
	if e := ctx.budget.consume(spec.bytes, true); e != nil {
		return e
	}
	in, e := os.Open(src)
	if e != nil {
		return e
	}
	defer in.Close()
	out, e := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	h := sha256.New()
	n, we := io.Copy(io.MultiWriter(out, h), io.LimitReader(in, spec.bytes+1))
	if we == nil && n != spec.bytes {
		we = fail("EXACT_FILE_SIZE_DRIFT")
	}
	if we == nil && hex.EncodeToString(h.Sum(nil)) != spec.sha {
		we = fail("EXACT_FILE_DIGEST_DRIFT")
	}
	if we == nil {
		we = out.Sync()
	}
	ce := out.Close()
	if we == nil {
		we = ce
	}
	if we != nil {
		_ = os.Remove(dst)
		return we
	}
	return c.attestRegular(dst, spec.bytes, spec.sha, ctx.deadline, true)
}

func slotRootFor(paths layout, revision string) string {
	if revision == revisionA {
		return filepath.Join(paths.testRoot, "revisions", "A")
	}
	return filepath.Join(paths.testRoot, "revisions", "B")
}
func expectedRevisionDir(revision string) (string, string, error) {
	switch revision {
	case revisionA:
		return "A", "", nil
	case revisionB:
		return "B", revisionA, nil
	default:
		return "", "", fail("UNAUTHORIZED_REVISION")
	}
}

func (c *controller) materializeSlot(ctx *executionContext, revision string) (slotAttestation, error) {
	if e := c.limits(ctx); e != nil {
		return slotAttestation{}, e
	}
	dirName, predecessor, e := expectedRevisionDir(revision)
	if e != nil {
		return slotAttestation{}, e
	}
	source, e := c.attestSource(ctx.deadline)
	if e != nil {
		return slotAttestation{}, e
	}
	root := filepath.Join(c.paths.testRoot, "revisions", dirName)
	for _, p := range []string{
		root,
		filepath.Join(root, "payload"),
		filepath.Join(root, "payload", "model"),
		filepath.Join(root, "payload", "runtime"),
		filepath.Join(root, "payload", "runtime", "b11033-vulkan"),
	} {
		if e = c.createDirExact(p); e != nil {
			return slotAttestation{}, e
		}
	}
	modelDst := filepath.Join(root, "payload", "model", "Qwen3.5-0.8B-Q8_0.gguf")
	assetDst := filepath.Join(root, "payload", "runtime", "llama-b11033-bin-win-vulkan-x64.zip")
	treeDst := filepath.Join(root, "payload", "runtime", "b11033-vulkan")
	if e = c.copyExact(ctx, c.paths.sourceModel, modelDst, fileSpec{bytes: modelBytes, sha: modelSHA}); e != nil {
		return slotAttestation{}, e
	}
	if e = c.copyExact(ctx, c.paths.sourceAsset, assetDst, fileSpec{bytes: runtimeAssetBytes, sha: runtimeAssetSHA}); e != nil {
		return slotAttestation{}, e
	}
	names := make([]string, 0, len(source.specs))
	for name := range source.specs {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if e = c.copyExact(ctx, filepath.Join(c.paths.sourceRuntime, name), filepath.Join(treeDst, name), source.specs[name]); e != nil {
			return slotAttestation{}, e
		}
	}
	if e = c.attestTree(treeDst, source.specs, ctx.deadline, true); e != nil {
		return slotAttestation{}, e
	}
	manifest := object{
		"profile_id": issuedID,
		"contract_id": "M1-08-RUNTIME-LIFECYCLE-SMOKE-PC-v0.1",
		"revision_id": revision,
		"predecessor_revision_id": nil,
		"model_relative_path": `payload\model\Qwen3.5-0.8B-Q8_0.gguf`,
		"model_bytes": json.Number(strconvFormatInt(modelBytes)),
		"model_sha256": modelSHA,
		"runtime_archive_relative_path": `payload\runtime\llama-b11033-bin-win-vulkan-x64.zip`,
		"runtime_archive_bytes": json.Number(strconvFormatInt(runtimeAssetBytes)),
		"runtime_archive_sha256": runtimeAssetSHA,
		"runtime_tree_attestation": "EXACT_RELEASE_ZIP_AND_EXTRACTED_TREE_MATCH / NO_EXTRA_MISSING_OR_MUTATED_FILES",
		"server_executable_relative_path": `payload\runtime\b11033-vulkan\llama-server.exe`,
		"server_executable_bytes": json.Number(strconvFormatInt(serverBytes)),
		"server_executable_sha256": serverSHA,
		"created_at_utc": c.now().UTC().Format(time.RFC3339Nano),
	}
	if predecessor != "" {
		manifest["predecessor_revision_id"] = predecessor
	}
	raw := canonical(manifest)
	manifestPath := filepath.Join(root, "manifest.json")
	if e = c.createNewSynced(manifestPath, raw, 0600); e != nil {
		return slotAttestation{}, e
	}
	return c.verifySlot(root, ctx.deadline)
}

func exactKeys(m object, keys []string) bool {
	if len(m) != len(keys) {
		return false
	}
	for _, k := range keys {
		if _, ok := m[k]; !ok {
			return false
		}
	}
	return true
}
func (c *controller) verifySlot(root string, deadline time.Time) (slotAttestation, error) {
	if !withinPath(c.paths.testRoot, root) {
		return slotAttestation{}, fail("REPARSE_POINT_OR_PATH_ESCAPE_DETECTED")
	}
	if e := c.verifySafeExistingPath(root); e != nil {
		return slotAttestation{}, e
	}
	manifestPath := filepath.Join(root, "manifest.json")
	if e := c.verifySafeExistingPath(manifestPath); e != nil {
		return slotAttestation{}, e
	}
	if e := c.verifyNoNamedStreams(manifestPath); e != nil {
		return slotAttestation{}, e
	}
	raw, e := os.ReadFile(manifestPath)
	if e != nil {
		return slotAttestation{}, e
	}
	m, e := decodeObject(raw)
	if e != nil {
		return slotAttestation{}, e
	}
	keys := []string{"profile_id", "contract_id", "revision_id", "predecessor_revision_id", "model_relative_path", "model_bytes", "model_sha256", "runtime_archive_relative_path", "runtime_archive_bytes", "runtime_archive_sha256", "runtime_tree_attestation", "server_executable_relative_path", "server_executable_bytes", "server_executable_sha256", "created_at_utc"}
	if !exactKeys(m, keys) {
		return slotAttestation{}, fail("SLOT_MANIFEST_SCHEMA_DRIFT")
	}
	revision := text(m, "revision_id")
	dirName, predecessor, e := expectedRevisionDir(revision)
	if e != nil || filepath.Base(root) != dirName {
		return slotAttestation{}, fail("SLOT_MANIFEST_REVISION_DRIFT")
	}
	if text(m, "profile_id") != issuedID || text(m, "contract_id") != "M1-08-RUNTIME-LIFECYCLE-SMOKE-PC-v0.1" {
		return slotAttestation{}, fail("SLOT_MANIFEST_SCOPE_DRIFT")
	}
	if predecessor == "" {
		if m["predecessor_revision_id"] != nil {
			return slotAttestation{}, fail("SLOT_MANIFEST_PREDECESSOR_DRIFT")
		}
	} else if text(m, "predecessor_revision_id") != predecessor {
		return slotAttestation{}, fail("SLOT_MANIFEST_PREDECESSOR_DRIFT")
	}
	expected := object{
		"model_relative_path": `payload\model\Qwen3.5-0.8B-Q8_0.gguf`,
		"model_bytes": json.Number(strconvFormatInt(modelBytes)),
		"model_sha256": modelSHA,
		"runtime_archive_relative_path": `payload\runtime\llama-b11033-bin-win-vulkan-x64.zip`,
		"runtime_archive_bytes": json.Number(strconvFormatInt(runtimeAssetBytes)),
		"runtime_archive_sha256": runtimeAssetSHA,
		"runtime_tree_attestation": "EXACT_RELEASE_ZIP_AND_EXTRACTED_TREE_MATCH / NO_EXTRA_MISSING_OR_MUTATED_FILES",
		"server_executable_relative_path": `payload\runtime\b11033-vulkan\llama-server.exe`,
		"server_executable_bytes": json.Number(strconvFormatInt(serverBytes)),
		"server_executable_sha256": serverSHA,
	}
	for k, v := range expected {
		if !equal(m[k], v) {
			return slotAttestation{}, faild("SLOT_MANIFEST_SCOPE_DRIFT", k)
		}
	}
	if _, e = utc(text(m, "created_at_utc")); e != nil {
		return slotAttestation{}, fail("SLOT_MANIFEST_TIME_INVALID")
	}
	model := filepath.Join(root, "payload", "model", "Qwen3.5-0.8B-Q8_0.gguf")
	asset := filepath.Join(root, "payload", "runtime", "llama-b11033-bin-win-vulkan-x64.zip")
	treeDir := filepath.Join(root, "payload", "runtime", "b11033-vulkan")
	if e = c.attestRegular(model, modelBytes, modelSHA, deadline, true); e != nil {
		return slotAttestation{}, e
	}
	if e = c.attestRegular(asset, runtimeAssetBytes, runtimeAssetSHA, deadline, true); e != nil {
		return slotAttestation{}, e
	}
	specs, treeSHA, e := zipSpecs(asset, deadline)
	if e != nil {
		return slotAttestation{}, e
	}
	if e = c.attestTree(treeDir, specs, deadline, true); e != nil {
		return slotAttestation{}, e
	}
	if e = c.attestRegular(filepath.Join(treeDir, "llama-server.exe"), serverBytes, serverSHA, deadline, true); e != nil {
		return slotAttestation{}, e
	}
	return slotAttestation{revision: revision, manifestSHA: sha(raw), modelSHA: modelSHA, assetSHA: runtimeAssetSHA, treeSHA: treeSHA, treeFiles: len(specs)}, nil
}

func currentPath(paths layout) string { return filepath.Join(paths.testRoot, "state", "current.json") }
func currentTempPath(paths layout, index int) string {
	return filepath.Join(paths.testRoot, "state", "current.transition-"+strconvFormatInt(int64(index))+".tmp")
}
func (c *controller) readCurrent() (object, []byte, error) {
	path := currentPath(c.paths)
	if e := c.verifySafeExistingPath(path); e != nil {
		return nil, nil, e
	}
	if e := c.verifyNoNamedStreams(path); e != nil {
		return nil, nil, e
	}
	raw, e := os.ReadFile(path)
	if e != nil {
		return nil, nil, e
	}
	m, e := decodeObject(raw)
	if e != nil {
		return nil, nil, e
	}
	keys := []string{"profile_id", "active_revision_id", "previous_active_revision_id", "transition_index", "slot_manifest_sha256", "payload_model_sha256", "payload_runtime_asset_sha256", "activated_at_utc", "transition_kind", "recovery_of_transition_index"}
	if !exactKeys(m, keys) {
		return nil, nil, fail("CURRENT_MANIFEST_SCHEMA_DRIFT")
	}
	return m, raw, nil
}
func transitionMatches(m object, spec transitionSpec) bool {
	if text(m, "profile_id") != issuedID ||
		text(m, "active_revision_id") != spec.to ||
		text(m, "transition_kind") != spec.kind {
		return false
	}
	idx, ok := m["transition_index"].(json.Number)
	if !ok || string(idx) != strconvFormatInt(int64(spec.index)) {
		return false
	}
	if spec.from == "" {
		if m["previous_active_revision_id"] != nil {
			return false
		}
	} else if text(m, "previous_active_revision_id") != spec.from {
		return false
	}
	return equal(m["recovery_of_transition_index"], spec.recoveryOf)
}
func (c *controller) assertCurrentPrecondition(spec transitionSpec) ([]byte, error) {
	path := currentPath(c.paths)
	if spec.index == 1 {
		if _, e := os.Lstat(path); os.IsNotExist(e) {
			return nil, nil
		} else if e != nil {
			return nil, e
		}
		return nil, fail("CURRENT_TRANSITION_INDEX_OR_PREVIOUS_REVISION_MISMATCH")
	}
	m, raw, e := c.readCurrent()
	if e != nil {
		return nil, e
	}
	if text(m, "active_revision_id") != spec.from {
		return nil, fail("CURRENT_TRANSITION_INDEX_OR_PREVIOUS_REVISION_MISMATCH")
	}
	var expectedPrior int
	switch {
	case spec.index == 2 && spec.kind == "NORMAL":
		expectedPrior = 1
	case spec.index == 3 && spec.kind == "NORMAL":
		expectedPrior = 2
	case spec.index == 3 && spec.kind == "RECOVERY":
		expectedPrior = 2
	case spec.index == 4 && spec.kind == "RECOVERY":
		expectedPrior = 3
	default:
		return nil, fail("UNAUTHORIZED_CURRENT_TRANSITION_INDEX_KIND_OR_RECOVERY_LINKAGE")
	}
	idx, ok := m["transition_index"].(json.Number)
	if !ok || string(idx) != strconvFormatInt(int64(expectedPrior)) {
		return nil, fail("CURRENT_TRANSITION_INDEX_OR_PREVIOUS_REVISION_MISMATCH")
	}
	return raw, nil
}

func (c *controller) verifyCurrentFailureAtomicity(oldRaw, newRaw []byte, initial bool) error {
	path := currentPath(c.paths)
	raw, e := os.ReadFile(path)
	if os.IsNotExist(e) && initial {
		return nil
	}
	if e != nil {
		return fail("CURRENT_MANIFEST_ATOMICITY_UNPROVEN")
	}
	if bytes.Equal(raw, newRaw) {
		return nil
	}
	if !initial && bytes.Equal(raw, oldRaw) {
		return nil
	}
	return fail("CURRENT_MANIFEST_ATOMICITY_UNPROVEN")
}

func (c *controller) publishCurrent(ctx *executionContext, spec transitionSpec) (object, error) {
	if e := c.limits(ctx); e != nil {
		return nil, e
	}
	legal := (spec.index == 1 && spec.kind == "NORMAL" && spec.from == "" && spec.to == revisionA && spec.recoveryOf == nil) ||
		(spec.index == 2 && spec.kind == "NORMAL" && spec.from == revisionA && spec.to == revisionB && spec.recoveryOf == nil) ||
		(spec.index == 3 && spec.kind == "NORMAL" && spec.from == revisionB && spec.to == revisionA && spec.recoveryOf == nil) ||
		(spec.index == 3 && spec.kind == "RECOVERY" && spec.from == revisionB && spec.to == revisionA && equal(spec.recoveryOf, json.Number("2"))) ||
		(spec.index == 4 && spec.kind == "RECOVERY" && spec.from == revisionA && spec.to == revisionB && equal(spec.recoveryOf, json.Number("3")))
	if !legal {
		return nil, fail("UNAUTHORIZED_CURRENT_TRANSITION_INDEX_KIND_OR_RECOVERY_LINKAGE")
	}
	oldRaw, e := c.assertCurrentPrecondition(spec)
	if e != nil {
		return nil, e
	}
	slot := slotRootFor(c.paths, spec.to)
	att, e := c.verifySlot(slot, ctx.deadline)
	if e != nil {
		return nil, e
	}
	current := object{
		"profile_id": issuedID,
		"active_revision_id": spec.to,
		"previous_active_revision_id": nil,
		"transition_index": json.Number(strconvFormatInt(int64(spec.index))),
		"slot_manifest_sha256": att.manifestSHA,
		"payload_model_sha256": modelSHA,
		"payload_runtime_asset_sha256": runtimeAssetSHA,
		"activated_at_utc": c.now().UTC().Format(time.RFC3339Nano),
		"transition_kind": spec.kind,
		"recovery_of_transition_index": spec.recoveryOf,
	}
	if spec.from != "" {
		current["previous_active_revision_id"] = spec.from
	}
	raw := canonical(current)
	temp := currentTempPath(c.paths, spec.index)
	if e = c.createNewSynced(temp, raw, 0600); e != nil {
		return nil, e
	}
	reopened, e := os.ReadFile(temp)
	if e != nil || !bytes.Equal(reopened, raw) || sha(reopened) != sha(raw) {
		return nil, fail("CURRENT_MANIFEST_ATOMICITY_UNPROVEN")
	}
	replace := spec.index != 1
	if e = c.sys.atomicPublish(temp, currentPath(c.paths), replace); e != nil {
		if ae := c.verifyCurrentFailureAtomicity(oldRaw, raw, spec.index == 1); ae != nil {
			return nil, ae
		}
		return nil, e
	}
	post, postRaw, e := c.readCurrent()
	if e != nil || !bytes.Equal(postRaw, raw) || !transitionMatches(post, spec) {
		return nil, fail("CURRENT_MANIFEST_ATOMICITY_UNPROVEN")
	}
	if _, e = c.verifySlot(slot, ctx.deadline); e != nil {
		return nil, e
	}
	if e = c.event(ctx, "LIFECYCLE", "current_published", object{
		"transition_index": json.Number(strconvFormatInt(int64(spec.index))),
		"from": current["previous_active_revision_id"],
		"to": spec.to,
		"transition_kind": spec.kind,
		"recovery_of_transition_index": spec.recoveryOf,
		"current_sha256": sha(postRaw),
	}); e != nil {
		return nil, e
	}
	return post, nil
}

func (c *controller) requireCurrentRevision(ctx *executionContext, revision string) error {
	if e := c.limits(ctx); e != nil {
		return e
	}
	m, _, e := c.readCurrent()
	if e != nil {
		return e
	}
	if text(m, "active_revision_id") != revision {
		return fail("CURRENT_TRANSITION_INDEX_OR_PREVIOUS_REVISION_MISMATCH")
	}
	slot := slotRootFor(c.paths, revision)
	att, e := c.verifySlot(slot, ctx.deadline)
	if e != nil {
		return e
	}
	if text(m, "slot_manifest_sha256") != att.manifestSHA ||
		text(m, "payload_model_sha256") != modelSHA ||
		text(m, "payload_runtime_asset_sha256") != runtimeAssetSHA {
		return fail("CURRENT_MANIFEST_SLOT_BINDING_DRIFT")
	}
	return nil
}

func (c *controller) removeUnverifiedInitialCurrent(ctx *executionContext) error {
	if e := c.requireContext(ctx); e != nil {
		return e
	}
	m, _, e := c.readCurrent()
	if e != nil {
		return e
	}
	if !transitionMatches(m, successTransition(1)) {
		return fail("CURRENT_TRANSITION_INDEX_OR_PREVIOUS_REVISION_MISMATCH")
	}
	path := currentPath(c.paths)
	if e = c.verifySafeExistingPath(path); e != nil {
		return e
	}
	return os.Remove(path)
}

func (c *controller) runtimeExpectedEntries(deadline time.Time) (map[string]bool, error) {
	source, e := c.attestSource(deadline)
	if e != nil {
		return nil, e
	}
	expected := map[string]bool{
		"state": true,
		filepath.Join("state", "temp"): true,
		filepath.Join("state", "current.json"): false,
		"revisions": true,
	}
	for _, d := range []string{"A", "B"} {
		root := filepath.Join("revisions", d)
		expected[root] = true
		expected[filepath.Join(root, "manifest.json")] = false
		expected[filepath.Join(root, "payload")] = true
		expected[filepath.Join(root, "payload", "model")] = true
		expected[filepath.Join(root, "payload", "model", "Qwen3.5-0.8B-Q8_0.gguf")] = false
		expected[filepath.Join(root, "payload", "runtime")] = true
		expected[filepath.Join(root, "payload", "runtime", "llama-b11033-bin-win-vulkan-x64.zip")] = false
		expected[filepath.Join(root, "payload", "runtime", "b11033-vulkan")] = true
		for name := range source.specs {
			expected[filepath.Join(root, "payload", "runtime", "b11033-vulkan", name)] = false
		}
	}
	return expected, nil
}

func (c *controller) removeRuntimeRootSuccess(ctx *executionContext) error {
	if e := c.limits(ctx); e != nil {
		return e
	}
	expected, e := c.runtimeExpectedEntries(ctx.deadline)
	if e != nil {
		return e
	}
	actual := map[string]bool{}
	e = filepath.WalkDir(c.paths.testRoot, func(path string, d os.DirEntry, er error) error {
		if er != nil {
			return er
		}
		if samePath(path, c.paths.testRoot) {
			return c.verifySafeExistingPath(path)
		}
		if !withinPath(c.paths.testRoot, path) {
			return fail("REPARSE_POINT_OR_PATH_ESCAPE_DETECTED")
		}
		if e := c.verifySafeExistingPath(path); e != nil {
			return e
		}
		rel, er := filepath.Rel(c.paths.testRoot, path)
		if er != nil {
			return er
		}
		actual[rel] = d.IsDir()
		return nil
	})
	if e != nil {
		return e
	}
	if len(actual) != len(expected) {
		return fail("UNEXPECTED_PREEXISTING_SLOT_OR_EVIDENCE_ENTRY")
	}
	for rel, isDir := range expected {
		if got, ok := actual[rel]; !ok || got != isDir {
			return faild("UNEXPECTED_PREEXISTING_SLOT_OR_EVIDENCE_ENTRY", rel)
		}
	}
	paths := make([]string, 0, len(actual))
	for rel := range actual {
		paths = append(paths, rel)
	}
	sort.Slice(paths, func(i, j int) bool {
		di := strings.Count(paths[i], string(filepath.Separator))
		dj := strings.Count(paths[j], string(filepath.Separator))
		if di != dj {
			return di > dj
		}
		return paths[i] > paths[j]
	})
	for _, rel := range paths {
		path := filepath.Join(c.paths.testRoot, rel)
		if e := c.verifySafeExistingPath(path); e != nil {
			return e
		}
		if e := os.Remove(path); e != nil {
			return e
		}
	}
	if e := c.verifySafeExistingPath(c.paths.testRoot); e != nil {
		return e
	}
	return os.Remove(c.paths.testRoot)
}
