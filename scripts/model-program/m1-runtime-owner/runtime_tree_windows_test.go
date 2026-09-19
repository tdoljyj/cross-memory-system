//go:build windows

package main

import (
	"archive/zip"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func runtimeTreeFixture(t *testing.T) (string, string, int64, string) {
	t.Helper()
	root := t.TempDir()
	asset := filepath.Join(root, "runtime.zip")
	tree := filepath.Join(root, "runtime")
	if e := os.Mkdir(tree, 0700); e != nil {
		t.Fatal(e)
	}
	files := map[string][]byte{
		"llama-server.exe":      []byte("server"),
		"llama-server-impl.dll": []byte("impl"),
	}
	f, e := os.Create(asset)
	if e != nil {
		t.Fatal(e)
	}
	z := zip.NewWriter(f)
	for _, name := range []string{"llama-server.exe", "llama-server-impl.dll"} {
		w, er := z.Create(name)
		if er != nil {
			t.Fatal(er)
		}
		if _, er = w.Write(files[name]); er != nil {
			t.Fatal(er)
		}
		if er = os.WriteFile(filepath.Join(tree, name), files[name], 0600); er != nil {
			t.Fatal(er)
		}
	}
	if e = z.Close(); e != nil {
		t.Fatal(e)
	}
	if e = f.Close(); e != nil {
		t.Fatal(e)
	}
	raw, e := os.ReadFile(asset)
	if e != nil {
		t.Fatal(e)
	}
	return asset, tree, int64(len(raw)), sha(raw)
}

func TestRuntimeTreeAttestationFailClosed(t *testing.T) {
	t.Run("exact_tree_passes", func(t *testing.T) {
		asset, tree, size, digest := runtimeTreeFixture(t)
		if e := attestRuntimeTreeAgainst(asset, tree, size, digest, time.Now().Add(10*time.Second)); e != nil {
			t.Fatal(e)
		}
	})
	t.Run("same_size_content_drift_rejected", func(t *testing.T) {
		asset, tree, size, digest := runtimeTreeFixture(t)
		if e := os.WriteFile(filepath.Join(tree, "llama-server-impl.dll"), []byte("evil"), 0600); e != nil {
			t.Fatal(e)
		}
		e := attestRuntimeTreeAgainst(asset, tree, size, digest, time.Now().Add(10*time.Second))
		if codeOf(e) != "EXACT_FILE_DIGEST_DRIFT" {
			t.Fatalf("got %v", e)
		}
	})
	t.Run("extra_file_rejected", func(t *testing.T) {
		asset, tree, size, digest := runtimeTreeFixture(t)
		if e := os.WriteFile(filepath.Join(tree, "extra.dll"), []byte("x"), 0600); e != nil {
			t.Fatal(e)
		}
		e := attestRuntimeTreeAgainst(asset, tree, size, digest, time.Now().Add(10*time.Second))
		if codeOf(e) != "RUNTIME_TREE_FILE_SET_DRIFT" {
			t.Fatalf("got %v", e)
		}
	})
	t.Run("missing_file_rejected", func(t *testing.T) {
		asset, tree, size, digest := runtimeTreeFixture(t)
		if e := os.Remove(filepath.Join(tree, "llama-server-impl.dll")); e != nil {
			t.Fatal(e)
		}
		e := attestRuntimeTreeAgainst(asset, tree, size, digest, time.Now().Add(10*time.Second))
		if codeOf(e) != "RUNTIME_TREE_FILE_SET_DRIFT" {
			t.Fatalf("got %v", e)
		}
	})
}
