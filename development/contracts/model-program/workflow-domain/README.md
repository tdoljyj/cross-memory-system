# Decision TaskSpec compatibility candidate

`TaskSpecs.candidate.v1.json` materializes the Owner-accepted r2 semantic
proposal (SHA `bee9d8146f52880951ca6b9b59903fd1d7073b309603694937e1a5fced4723ba`).
It contains the three logical TaskSpecs, unchanged accepted output schemas,
concrete private input-binding schemas, definitions and required branches.
The Owner direction is Decision `d78f94a5-5476-408c-9290-313e84014dfa` v1,
Receipt `7d646935-e5a1-40a8-af50-11406c3a1af6`; it accepts semantic direction.

`workflow_domain_contract.bind_task_input` checks the package byte pin,
selected input structure and original request's output-schema digest, then
supplies arguments to the existing saved decision projection. It never sends
a request. The input schemas describe that projection's private `task_input`,
not model prompts, Context objects or a new Port envelope. The caller still
binds actual prompt input digest, permission-filtered Context snapshot/watermark,
policy and original invocation identity through existing v2 fields.

These logical TaskSpecs remain candidates pending the existing model/Schema
domain's versioned compatibility adoption. No formal Schema/Capability/label
registration, frozen M0-A/B/C replacement, new Gate or issuer is made here.

`project_task_snapshot` connects this candidate definition package to the
existing saved projection. For Context raw scores it enforces HIGHER_FIRST
and an explicit caller-frozen complete Context ID order for ties. Rank-only
output does not acquire invented scores or ties. External reference grades
must be discrete levels 0–3; malformed reference configuration refuses the
batch before judging model replies, while missing reference truth stays unknown.
The generic scorer and generic projection without this optional contract retain
their existing behaviour. Whole accepted definition-object digests reject
semantic drift even if a caller supplies a newly computed package hash.

The report retains the exact local Context contract/digest and definition-package
digest for replay; these identities do not prove actual freeze or authority.

Structural validity does not establish content truth, Gold, calibration,
permission, runtime availability or qualified Provider support. Definitions of
route classes do not create routes; actual catalogues and actions remain code
and Policy inputs. Scoring reference scale does not assign any sample a grade.

Actual domain bindings stay null. Lawful external scoring/threshold/freeze and
the applicable exact experiment/input-use permission, qualified runtime and
fixed caller remain required for their respective stages. Old experiments and
VMs stay terminal. All C1/C2/C3 qualification, activation and complete M0–M7
obligations remain under original Task `1502fd80-8ff8-4adc-b4f5-da6d462f4f8a`.
