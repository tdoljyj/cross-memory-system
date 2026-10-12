# Development input rendering

`scripts/model-program/development_input_renderer.py` renders explicit caller
specifications into candidate M0-A `segment_input.v1` inputs. It preserves the
exact existing Segment schema bytes; the frozen original Core24 generator,
contracts and scorer are unchanged. The seven track names are preparation
coverage keys, not registered TaskSpec/Capability IDs.

The API is `render_development(spec_raw, segment_schema_raw,
declared_renderer_sha256=...) -> bytes`. It has no CLI, default scenarios,
randomness, model/teacher/API call, file writer or label inference. The caller
must admit actual synthetic data creation and verify source, rights, purpose,
templates and scenario roots before invoking it. Ordinary source/test approval
does not grant that data effect. This module performs no authority lookup or
issuance; a caller hash is explicitly declared metadata, not code attestation.

Date/time checking uses a private instance format checker with explicit RFC3339
syntax and calendar checks, including offset-adjusted potential leap-second
placement. It does not attest actual events or leap-second announcements. This
avoids the optional dependency silently disabling date-time validation; no
global checker, library pin, installed dependency or existing schema is changed.
See [jsonschema format validation](https://python-jsonschema.readthedocs.io/en/stable/validate/#validating-formats)
and [RFC3339 sections 5.6-5.8](https://www.rfc-editor.org/rfc/rfc3339.txt).

`spec_raw` is bounded strict UTF-8 JSON with `purpose_id=development`,
`source_class=C`, a template list and a scenario list. Templates contain `id`,
`reference_time`, `timezone`, and existing Segment message fields except that
`content_template` replaces `content`. Scenarios contain `id`, `source_ref`,
`root_id`, `family_id`, `semantic_group_id`, `template_id`, `track`, `language`
(`zh/en/mixed`), `risk` (`ordinary/boundary`), `difficulty` (`direct/compound`)
and string `variables`. Only `{{name}}` substitutions are allowed, once; unused
or missing variables fail. This is a local implementation API, not a new
Domain Schema, DatasetSplit value, Consumer/Role or admission contract.

Limits are 256 KiB specification bytes, 168 candidate rows, 64 KiB encoded input
per row and 2 MiB packet bytes. These Source bounds are not authorization of a
168-row Dataset or an experiment budget. Repeated roots/families/declared groups
are rejected globally, including across tracks. Exact rendered-content checks
ignore renamable IDs. They do not establish semantic dedup or independent n;
declared group IDs and provenance still need external review. Shared templates,
translations and projections cannot become independent evidence by renaming.

The packet records raw specification/schema hashes, template/scenario/input
hashes and declared provenance. It is author-visible development only, with
effective independent count unknown, semantic dedup and rights unverified,
Gold `null`, M2 `NOT_ISSUED` and authority effect `NONE`. Three decision workflows
remain unadmitted until their existing formal task/workflow/scoring inputs and
allowed branches are supplied through the applicable existing authority path.
It does not bind the new packet to the original fixed24 scorer or issue a new
Source consumer; actual evaluation needs its properly admitted existing reader.

Actual source-pool/group/custody/access freeze still precedes selection feedback;
final Holdout follows exact final candidate freeze under independent custody.
This API cannot assign any other purpose or turn development into unseen data.
The full five Suites, three workflows and three Tier qualification/activation
and M7 obligations remain outside this preparation result.

Regression tests use already public Core24 input material and small inert
engineering mocks only. They do not materialize the proposed new168 corpus,
formal Gold, reserved sources or actual model measurements.
