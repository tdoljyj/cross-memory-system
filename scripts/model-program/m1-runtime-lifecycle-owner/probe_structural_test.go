package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestPC003StructuralProbeAcceptsPriorFailureShape(t *testing.T) {
	raw := []byte(`{"content":"Not literally OK, but inference completed.","stop":true,"tokens_predicted":7,"tokens_evaluated":5,"stop_type":"limit"}`)
	got, e := structuralProbeSummary(raw)
	if e != nil {
		t.Fatalf("structural response rejected: %v", e)
	}
	if got["response_sha256"] != sha(raw) || got["content_sha256"] != sha([]byte("Not literally OK, but inference completed.")) {
		t.Fatal("probe evidence hash mismatch")
	}
	if strings.Contains(string(canonical(got)), "Not literally OK") {
		t.Fatal("raw model content leaked into evidence summary")
	}
}

func TestPC003StructuralProbeRejectsInvalidShapes(t *testing.T) {
	cases := []struct{ name, raw string }{
		{"empty-content", `{"content":"  ","stop":true,"tokens_predicted":1,"tokens_evaluated":5}`},
		{"zero-predicted", `{"content":"x","stop":true,"tokens_predicted":0,"tokens_evaluated":5}`},
		{"zero-evaluated", `{"content":"x","stop":true,"tokens_predicted":1,"tokens_evaluated":0}`},
		{"false-stop", `{"content":"x","stop":false,"tokens_predicted":1,"tokens_evaluated":5}`},
		{"invalid-json", `{"content":`},
		{"wrong-type", `{"content":"x","stop":true,"tokens_predicted":"1","tokens_evaluated":5}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, e := structuralProbeSummary([]byte(tc.raw)); e == nil {
				t.Fatal("invalid probe passed")
			}
		})
	}
}

func TestPC003StructuralProbeLimitsAndHTTP(t *testing.T) {
	if _, e := structuralProbeSummary([]byte(strings.Repeat("x", (1<<20)+1))); codeOf(e) != "PROBE_RESPONSE_LIMIT" {
		t.Fatalf("oversize: %v", e)
	}
	if e := validateProbeHTTPStatus(503); codeOf(e) != "PROBE_HTTP_FAILURE" {
		t.Fatalf("non-2xx: %v", e)
	}
	if e := validateProbeHTTPStatus(200); e != nil {
		t.Fatalf("2xx rejected: %v", e)
	}
}

func TestPC003StructuralProbeEvidenceNumbers(t *testing.T) {
	raw := []byte(`{"content":"x","stop":true,"tokens_predicted":7,"tokens_evaluated":5,"stop_type":"eos"}`)
	got, e := structuralProbeSummary(raw)
	if e != nil {
		t.Fatal(e)
	}
	if got["tokens_predicted"] != json.Number("7") || got["tokens_evaluated"] != json.Number("5") {
		t.Fatalf("token evidence drift: %#v", got)
	}
}
