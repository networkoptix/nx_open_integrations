# Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
"""
Offline tests for spec_lookup.py. No network, no spec file needed.

Run from this folder:  python3 -m unittest -v test_spec_lookup

Two seams are tested, and only these two:

  * schema_fields(spec, schema) -- the rendering contract. What a caller is
    told about a request or response body.
  * main(argv) -- the CLI: its return code, its stdout and its stderr.
"""

import contextlib
import io
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import spec_lookup


def rendered(schema, spec=None, **kwargs):
    """schema_fields output, stripped of indentation, for readable assertions."""
    lines = spec_lookup.schema_fields(spec or {}, schema, **kwargs)
    return [line.strip() for line in lines]


class CliResult:
    def __init__(self, code, out, err):
        self.code, self.out, self.err = code, out, err


@contextlib.contextmanager
def spec_file(document):
    with tempfile.TemporaryDirectory() as folder:
        path = os.path.join(folder, "spec.json")
        with open(path, "w", encoding="utf-8") as handle:
            if isinstance(document, str):
                handle.write(document)
            else:
                json.dump(document, handle)
        yield path


def run_cli(*argv, **kwargs):
    """Drive main() exactly as the shell would, capturing both streams."""
    document = kwargs.pop("spec", {"openapi": "3.0.2", "paths": {}})
    out, err = io.StringIO(), io.StringIO()
    with spec_file(document) as path:
        argv = ["--spec", path] + list(argv)
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = spec_lookup.main(argv)
    return CliResult(code, out.getvalue(), err.getvalue())


def one_path(operation, path="/x", method="get"):
    return {"openapi": "3.0.2", "info": {"title": "t"},
            "paths": {path: {method: operation}}}


BODY = {"requestBody": {"content": {"application/json": {"schema": {
    "type": "object", "required": ["physicalId"],
    "properties": {"physicalId": {"type": "string"}}}}}}}


class TestFieldTypes(unittest.TestCase):

    def test_a_field_with_no_declared_type_is_not_claimed_to_be_an_object(self):
        # The old default turned "I don't know" into "it's an object", which a
        # reader acts on. An unknown type must look unknown.
        schema = {"type": "object",
                  "properties": {"mystery": {"description": "no type here"}}}
        self.assertEqual(rendered(schema), ["mystery: ?"])

    def test_a_oneOf_field_reports_every_member_type(self):
        # Real case from the spec: Server.runtimeInformation.timezone
        # .timeZoneOffsetMs is oneOf [integer, string]. It used to print as
        # "object", so a caller would send {} and get a 400.
        schema = {"type": "object", "properties": {"timeZoneOffsetMs": {
            "description": "Time zone offset, in milliseconds.",
            "oneOf": [{"type": "integer"}, {"type": "string", "example": ""}]}}}
        self.assertEqual(rendered(schema), ["timeZoneOffsetMs: integer|string"])


class TestRequiredFields(unittest.TestCase):

    def test_required_body_fields_are_marked(self):
        # POST /rest/v4/devices really does require exactly these three. Without
        # a marker they looked identical to the other 79 optional fields, so the
        # one thing a caller must know was the one thing the tool would not say.
        schema = {"type": "object",
                  "required": ["physicalId", "url"],
                  "properties": {"physicalId": {"type": "string"},
                                 "url": {"type": "string"},
                                 "name": {"type": "string"}}}
        self.assertEqual(rendered(schema),
                         ["physicalId*: string", "url*: string", "name: string"])

    def test_show_explains_what_the_required_marker_means(self):
        # A marker nobody can decode is noise. Print the legend where the
        # marked fields are, not in --help.
        result = run_cli("show", "/x", spec=one_path(BODY, method="post"))
        self.assertIn("* = required", result.out)
        self.assertIn("physicalId*: string", result.out)



class TestNestedArrays(unittest.TestCase):

    def test_the_item_fields_of_a_nested_array_are_expanded(self):
        # Device.options.bitrateInfos is an array of objects. Only the top-level
        # array was ever unpacked, so every nested one stopped at
        # "array<object>" -- the fields inside it were unreachable.
        schema = {"type": "object", "properties": {
            "bitrateInfos": {"type": "array", "items": {
                "type": "object",
                "required": ["bitrateKbps"],
                "properties": {"bitrateKbps": {"type": "integer"},
                               "codec": {"type": "string"}}}}}}
        self.assertEqual(rendered(schema), [
            "bitrateInfos: array<object>",
            "bitrateInfos[].bitrateKbps*: integer",
            "bitrateInfos[].codec: string",
        ])

    def test_an_array_of_scalars_names_the_scalar_type(self):
        schema = {"type": "object", "properties": {
            "ids": {"type": "array", "items": {"type": "string"}}}}
        self.assertEqual(rendered(schema), ["ids: array<string>"])

    def test_an_array_whose_item_type_is_unstated_is_not_called_an_object(self):
        schema = {"type": "object",
                  "properties": {"blobs": {"type": "array", "items": {}}}}
        self.assertEqual(rendered(schema), ["blobs: array<?>"])


def nested(levels, leaf="string"):
    """An object nested `levels` deep, the innermost holding one field."""
    node = {"type": "object", "properties": {"leaf": {"type": leaf}}}
    for index in reversed(range(levels)):
        node = {"type": "object",
                "properties": {"lvl{}".format(index): node}}
    return node


class TestDepthLimit(unittest.TestCase):

    def test_fields_cut_off_by_the_depth_limit_are_announced(self):
        # 10 of the 82 fields of POST /rest/v4/devices vanished with no marker,
        # so the output looked complete when it was not.
        lines = rendered(nested(4))
        self.assertIn("lvl0.lvl1.lvl2.lvl3: object", lines)
        self.assertNotIn("lvl0.lvl1.lvl2.lvl3.leaf: string", lines)
        self.assertTrue(
            any("truncated" in line and "--depth" in line for line in lines),
            "no truncation marker in:\n" + "\n".join(lines))

    def test_raising_the_depth_reveals_them(self):
        lines = rendered(nested(4), max_depth=9)
        self.assertIn("lvl0.lvl1.lvl2.lvl3.leaf: string", lines)
        self.assertFalse(any("truncated" in line for line in lines))

    def test_nothing_is_announced_when_nothing_was_cut(self):
        lines = rendered({"type": "object",
                          "properties": {"a": {"type": "string"}}})
        self.assertEqual(lines, ["a: string"])

    def test_the_depth_flag_reaches_the_renderer(self):
        deep = {"requestBody": {"content": {"application/json": {
            "schema": nested(4)}}}}
        shallow = run_cli("show", "/x", spec=one_path(deep, method="post"))
        self.assertNotIn("lvl3.leaf", shallow.out)
        deeper = run_cli("show", "/x", "--depth", "9",
                         spec=one_path(deep, method="post"))
        self.assertIn("lvl0.lvl1.lvl2.lvl3.leaf: string", deeper.out)


class TestEnums(unittest.TestCase):

    def test_an_enum_lists_its_legal_values(self):
        # 1381 enums in the spec printed as a bare "string". Guessing the value
        # of failoverPriority is a 400 the caller cannot diagnose.
        schema = {"type": "object", "properties": {"failoverPriority": {
            "type": "string", "enum": ["Never", "Low", "Medium", "High"]}}}
        self.assertEqual(rendered(schema),
                         ["failoverPriority: string{Never|Low|Medium|High}"])

    def test_a_long_enum_is_cut_but_says_so(self):
        values = ["v{}".format(n) for n in range(12)]
        schema = {"type": "object",
                  "properties": {"code": {"type": "string", "enum": values}}}
        line = rendered(schema)[0]
        self.assertIn("v0|v1", line)
        self.assertIn("+4 more", line)
        self.assertNotIn("v11", line)


class TestExitCodes(unittest.TestCase):
    """The docstring promises: 1 when a lookup finds nothing, 2 on an error."""

    def test_show_exits_1_when_the_path_has_no_such_method(self):
        # It printed an empty banner and exited 0, so
        # `if spec_lookup.py show X --method delete` silently took the
        # "yes, it exists" branch.
        result = run_cli("show", "/x", "--method", "delete",
                         spec=one_path({"summary": "Get it"}))
        self.assertEqual(result.code, 1)
        self.assertIn("delete", result.err.lower())

    def test_show_exits_0_when_the_method_is_there(self):
        result = run_cli("show", "/x", "--method", "get",
                         spec=one_path({"summary": "Get it"}))
        self.assertEqual(result.code, 0)
        self.assertIn("Get it", result.out)

    def test_unparsable_spec_exits_2_not_1(self):
        # A traceback exits 1, which is the same code as "found nothing". A
        # script branching on it treats a corrupt spec as an empty result.
        result = run_cli("find", "device", spec='{"paths": ')
        self.assertEqual(result.code, 2)
        self.assertIn("not valid JSON", result.err)
        self.assertEqual(result.out, "")

    def test_a_spec_that_is_not_an_object_exits_2(self):
        result = run_cli("find", "device", spec=[1, 2])
        self.assertEqual(result.code, 2)
        self.assertIn("not an OpenAPI document", result.err)

    def test_a_missing_spec_still_exits_2(self):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = spec_lookup.main(["--spec", "/nope/absent.json", "find", "x"])
        self.assertEqual(code, 2)
        self.assertIn("absent.json", err.getvalue())


class TestStreams(unittest.TestCase):
    """stdout is the answer. Diagnostics go to stderr or they pollute a pipe."""

    def test_find_reports_no_match_on_stderr_and_keeps_stdout_clean(self):
        result = run_cli("find", "nothing", spec=one_path({"summary": "s"}))
        self.assertEqual(result.code, 1)
        self.assertEqual(result.out, "")
        self.assertIn("nothing", result.err)

    def test_permissions_reports_no_match_on_stderr(self):
        result = run_cli("permissions", "nothing", spec=one_path({"summary": "s"}))
        self.assertEqual(result.code, 1)
        self.assertEqual(result.out, "")
        self.assertIn("nothing", result.err)

    def test_a_hit_still_goes_to_stdout(self):
        result = run_cli("find", "x", spec=one_path({"summary": "s"}))
        self.assertEqual(result.code, 0)
        self.assertIn("/x", result.out)
        self.assertEqual(result.err, "")


class TestStaleHonesty(unittest.TestCase):

    def test_matching_paths_are_not_reported_as_a_matching_spec(self):
        # diff_specs compares path names, method names and the deprecated flag.
        # It does not look at parameters, schemas or x-permissions, so "the
        # vendored spec matches the reference" was a claim it cannot make.
        ours = {"openapi": "3.0.2", "info": {"title": "t"}, "paths": {"/x": {
            "get": {"parameters": [{"name": "old", "in": "query"}]}}}}
        theirs = {"openapi": "3.0.2", "info": {"title": "t"}, "paths": {"/x": {
            "get": {"parameters": [{"name": "brandNew", "in": "query"}],
                    "x-permissions": "Administrator"}}}}
        with spec_file(theirs) as reference:
            result = run_cli("stale", "--against", reference, spec=ours)
        self.assertEqual(result.code, 0)
        self.assertNotIn("matches the reference", result.out)
        self.assertIn("paths and methods", result.out)
        self.assertIn("not compared", result.out.lower())

    def test_real_drift_is_still_reported_and_exits_1(self):
        ours = one_path({"summary": "s"})
        theirs = {"openapi": "3.0.2", "info": {"title": "t"},
                  "paths": {"/x": {"get": {}, "post": {}}}}
        with spec_file(theirs) as reference:
            result = run_cli("stale", "--against", reference, spec=ours)
        self.assertEqual(result.code, 1)
        self.assertIn("+POST", result.out)


class TestRecursiveSchemas(unittest.TestCase):

    def test_a_self_referential_array_is_cut_off_not_a_crash(self):
        # The top-level array branch reused its caller's depth, so an array
        # whose items point back at itself recursed until Python gave up.
        spec = {"paths": {}, "components": {"schemas": {"L": {
            "type": "array", "items": {"$ref": "#/components/schemas/L"}}}}}
        lines = spec_lookup.schema_fields(spec, {"$ref": "#/components/schemas/L"})
        self.assertEqual(lines, [])

    def test_a_self_referential_object_reports_what_it_cut(self):
        # Device advanced manifests really do nest groups inside groups.
        spec = {"paths": {}, "components": {"schemas": {"G": {
            "type": "object", "properties": {
                "name": {"type": "string"},
                "groups": {"type": "array",
                           "items": {"$ref": "#/components/schemas/G"}}}}}}}
        lines = rendered({"$ref": "#/components/schemas/G"}, spec=spec)
        self.assertEqual(lines[0], "name: string")
        self.assertTrue(any("truncated" in line for line in lines))


class TestMaps(unittest.TestCase):

    def test_a_free_form_map_names_its_value_type(self):
        # Server.network.networkInterfaces is a string-keyed map. Printing "?"
        # was honest but useless: the spec does say what the values are.
        schema = {"type": "object", "properties": {"networkInterfaces": {
            "readOnly": True,
            "additionalProperties": {"type": "string", "example": ""}}}}
        self.assertEqual(rendered(schema),
                         ["networkInterfaces: map<string>"])

    def test_a_map_of_objects_shows_the_value_fields(self):
        schema = {"type": "object", "properties": {"byId": {
            "additionalProperties": {"type": "object", "required": ["id"],
                                     "properties": {"id": {"type": "string"}}}}}}
        self.assertEqual(rendered(schema),
                         ["byId: map<object>", "byId{}.id*: string"])

    def test_an_untyped_map_is_still_a_map(self):
        schema = {"type": "object",
                  "properties": {"extras": {"additionalProperties": True}}}
        self.assertEqual(rendered(schema), ["extras: map<?>"])


class TestComposition(unittest.TestCase):
    """This spec uses only oneOf today, but --spec takes any OpenAPI file."""

    def test_anyOf_is_a_union_like_oneOf(self):
        schema = {"type": "object", "properties": {"when": {
            "anyOf": [{"type": "string"}, {"type": "integer"}]}}}
        self.assertEqual(rendered(schema), ["when: string|integer"])

    def test_allOf_merges_the_fields_of_every_member(self):
        # allOf is an intersection: a value must satisfy all members, so the
        # caller has to send the union of their fields. Rendering it as "?"
        # would hide a whole request body.
        schema = {"type": "object", "properties": {"device": {"allOf": [
            {"type": "object", "required": ["id"],
             "properties": {"id": {"type": "string"}}},
            {"type": "object", "properties": {"name": {"type": "string"}}}]}}}
        self.assertEqual(rendered(schema),
                         ["device: object", "device.id*: string",
                          "device.name: string"])

    def test_a_oneOf_of_objects_still_reports_object(self):
        # Union of shapes, not of scalars: naming the type is all we can
        # honestly say without inventing a merge.
        schema = {"type": "object", "properties": {"either": {"oneOf": [
            {"type": "object", "properties": {"a": {"type": "string"}}},
            {"type": "object", "properties": {"b": {"type": "string"}}}]}}}
        self.assertEqual(rendered(schema), ["either: object"])


# --------------------------------------------------------------------------
# Ported from the --selftest that used to live inside spec_lookup.py.
# --------------------------------------------------------------------------

def fabricated(paths, title="REST v4 (VMS 6.1+)"):
    return {"openapi": "3.0.2", "info": {"title": title}, "paths": paths}


VENDORED = fabricated({
    "/rest/v4/devices": {"get": {}, "post": {}},
    "/rest/v4/login/sessions": {"post": {}},
    "/rest/v4/gone": {"get": {}},
    "/ec2/old": {"get": {}},
})
LIVE = fabricated({
    "/rest/v4/devices": {"get": {}},                        # lost POST
    "/rest/v4/login/sessions": {"post": {}, "delete": {}},   # gained DELETE
    "/rest/v4/brandNew": {"get": {}},                        # added
    "/ec2/old": {"get": {"deprecated": True}},               # newly deprecated
})


class TestResponses(unittest.TestCase):

    def test_a_response_documented_under_default_is_printed(self):
        # Every one of this spec's responses sits under "default", none under a
        # 2xx code. Filtering to 2xx printed nothing, which reads as "no body".
        result = run_cli("show", "/x", spec=one_path({"responses": {"default": {
            "description": "List of things.",
            "content": {"application/json": {"schema": {
                "type": "array", "items": {
                    "type": "object",
                    "properties": {"name": {"type": "string"}}}}}}}}}))
        self.assertIn("[].name: string", result.out)
        self.assertIn("List of things.", result.out)


class TestPermissions(unittest.TestCase):

    GUARDED = {"summary": "Do it", "responses": {},
               "x-permissions": "Administrator with a fresh session."}

    def test_show_prints_x_permissions(self):
        # This spec's `security` is null throughout; permissions live in the
        # extension. Without it a sample is blind to who may call the endpoint.
        result = run_cli("show", "/y",
                         spec=one_path(self.GUARDED, path="/y", method="post"))
        self.assertIn("Administrator with a fresh session.", result.out)

    def test_the_permissions_command_names_the_operation(self):
        result = run_cli("permissions", "y",
                         spec=one_path(self.GUARDED, path="/y", method="post"))
        self.assertEqual(result.code, 0)
        self.assertIn("POST", result.out)
        self.assertIn("/y", result.out)


class TestDiffSpecs(unittest.TestCase):

    def setUp(self):
        self.diff = spec_lookup.diff_specs(VENDORED, LIVE)

    def test_a_path_added_upstream_is_reported(self):
        self.assertEqual(self.diff["added"], ["/rest/v4/brandNew"])

    def test_a_path_removed_upstream_is_reported(self):
        self.assertEqual(self.diff["removed"], ["/rest/v4/gone"])

    def test_gained_and_lost_methods_are_both_reported(self):
        # /ec2/old changed only its deprecated flag, so it must NOT be here.
        self.assertEqual(sorted(self.diff["changed"]),
                         [("/rest/v4/devices", [], ["post"]),
                          ("/rest/v4/login/sessions", ["delete"], [])])

    def test_an_operation_newly_marked_deprecated_is_reported(self):
        self.assertEqual(self.diff["newly_deprecated"], [("GET", "/ec2/old")])

    def test_identical_specs_report_no_differences(self):
        same = spec_lookup.diff_specs(VENDORED, VENDORED)
        self.assertEqual([same["added"], same["removed"],
                          same["changed"], same["newly_deprecated"]],
                         [[], [], [], []])

    def test_an_already_deprecated_operation_is_not_newly_deprecated(self):
        both = fabricated({"/x": {"get": {"deprecated": True}}})
        self.assertEqual(
            spec_lookup.diff_specs(both, both)["newly_deprecated"], [])


class TestStaleExitCodes(unittest.TestCase):

    def test_stale_exits_0_when_in_sync(self):
        with spec_file(VENDORED) as reference:
            result = run_cli("stale", "--against", reference, spec=VENDORED)
        self.assertEqual(result.code, 0)

    def test_stale_exits_1_when_drifted(self):
        with spec_file(LIVE) as reference:
            result = run_cli("stale", "--against", reference, spec=VENDORED)
        self.assertEqual(result.code, 1)

    def test_stale_exits_2_when_the_reference_cannot_be_read(self):
        result = run_cli("stale", "--against", "/nope/absent.json",
                         spec=VENDORED)
        self.assertEqual(result.code, 2)
        self.assertEqual(result.out, "")

    def test_a_title_mismatch_is_flagged(self):
        with spec_file(fabricated({}, title="Something else")) as reference:
            result = run_cli("stale", "--against", reference, spec=VENDORED)
        self.assertIn("titles differ", result.out)

    def test_deprecated_lists_every_deprecated_operation(self):
        result = run_cli("deprecated", spec=LIVE)
        self.assertIn("/ec2/old", result.out)
        self.assertNotIn("/rest/v4/brandNew", result.out)


class TestRefResolution(unittest.TestCase):

    def test_an_escaped_ref_resolves(self):
        # RFC 6901: "~1" is "/" and "~0" is "~" inside a JSON Pointer. Splitting
        # the raw string walked into a component that does not exist and
        # returned an empty schema -- with no error.
        spec = {"paths": {}, "components": {"schemas": {"a/b~c": {
            "type": "object", "properties": {"x": {"type": "string"}}}}}}
        self.assertEqual(
            rendered({"$ref": "#/components/schemas/a~1b~0c"}, spec=spec),
            ["x: string"])

    def test_a_ref_that_points_nowhere_is_named_not_swallowed(self):
        # resolve() returned {} for a dangling $ref, so a whole sub-object
        # disappeared and the output still looked complete.
        spec = {"paths": {}, "components": {"schemas": {}}}
        schema = {"type": "object", "properties": {
            "thing": {"$ref": "#/components/schemas/Missing"}}}
        self.assertEqual(rendered(schema, spec=spec),
                         ["thing: <unresolved $ref: #/components/schemas/Missing>"])

    def test_an_external_ref_is_named_too(self):
        schema = {"type": "object", "properties": {
            "thing": {"$ref": "other.json#/Thing"}}}
        self.assertEqual(rendered(schema),
                         ["thing: <unresolved $ref: other.json#/Thing>"])


class TestMethodArgument(unittest.TestCase):

    def test_the_method_is_accepted_in_any_case(self):
        # HTTP methods are conventionally written in caps, and that is how the
        # tool prints them back. Rejecting --method POST is a papercut.
        result = run_cli("show", "/x", "--method", "POST",
                         spec=one_path({"summary": "Made it"}, method="post"))
        self.assertEqual(result.code, 0)
        self.assertIn("Made it", result.out)


class FakeHttpResponse:
    """Stands in for the object urlopen returns. Only .read() is used."""

    def __init__(self, payload):
        self.payload = payload

    def read(self, size=-1):
        return self.payload if size < 0 else self.payload[:size]

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class TestDownloadLimit(unittest.TestCase):
    """The only mocked boundary in this file: the network itself."""

    def fake_urlopen(self, payload):
        import urllib.request

        original = urllib.request.urlopen
        urllib.request.urlopen = lambda *a, **k: FakeHttpResponse(payload)
        self.addCleanup(setattr, urllib.request, "urlopen", original)

    def test_an_oversized_reference_is_refused_rather_than_buffered(self):
        self.fake_urlopen(b"[" + b" " * (spec_lookup.MAX_DOWNLOAD + 10) + b"]")
        result = run_cli("stale", "--against", "https://host/spec.json",
                         spec=VENDORED)
        self.assertEqual(result.code, 2)
        self.assertIn("too large", result.err)

    def test_a_normal_reference_downloads(self):
        self.fake_urlopen(json.dumps(VENDORED).encode("utf-8"))
        result = run_cli("stale", "--against", "https://host/spec.json",
                         spec=VENDORED)
        self.assertEqual(result.code, 0)

    def test_an_https_failure_suggests_insecure(self):
        import urllib.request

        original = urllib.request.urlopen

        def boom(*a, **k):
            raise OSError("certificate verify failed")

        urllib.request.urlopen = boom
        self.addCleanup(setattr, urllib.request, "urlopen", original)
        result = run_cli("stale", "--against", "https://host/spec.json",
                         spec=VENDORED)
        self.assertEqual(result.code, 2)
        self.assertIn("--insecure", result.err)


class TestOneLineText(unittest.TestCase):
    """Prose from the spec is printed inside an indented block."""

    MULTILINE = {"responses": {"default": {
        "description": "Archive rebuilding process information\nobject per "
                       "Archive location.",
        "content": {"application/json": {"schema": {
            "type": "object", "properties": {"state": {"type": "string"}}}}}}}}

    def test_a_multi_line_description_does_not_break_out_of_the_block(self):
        # 12 response descriptions in the spec wrap. The continuation landed in
        # column 0, so the field list below it read as a separate section.
        result = run_cli("show", "/x", spec=one_path(self.MULTILINE))
        body = [line for line in result.out.splitlines()
                if "Archive" in line]
        self.assertEqual(len(body), 1)
        self.assertTrue(body[0].startswith("  response:"), body[0])
        self.assertNotIn("\nobject per", result.out)

    def test_a_wrapped_description_keeps_all_of_its_words(self):
        # Taking splitlines()[0] fits the block but drops the rest of the
        # sentence with no marker -- the same silent loss this tool exists to
        # stop. A wrapped description is one sentence; unwrap it.
        result = run_cli("show", "/x", spec=one_path(self.MULTILINE))
        self.assertIn(
            "response:  Archive rebuilding process information object per "
            "Archive location.", result.out)

    def test_a_long_description_is_cut_and_says_so(self):
        long_text = "word " * 60
        result = run_cli("show", "/x", spec=one_path(
            {"responses": {"default": {"description": long_text}}}))
        line = [l for l in result.out.splitlines() if "word" in l][0]
        self.assertLess(len(line), 130)
        self.assertTrue(line.rstrip().endswith("..."), line)

    def test_deprecated_shares_the_same_rule(self):
        # cmd_deprecated grew its own .splitlines()[0][:100] for the same
        # problem. One rule, one place.
        long_text = "word " * 60 + "\nsecond line"
        result = run_cli("deprecated", spec=one_path(
            {"deprecated": True, "description": long_text}))
        line = [l for l in result.out.splitlines() if "word" in l][0]
        self.assertLess(len(line), 130)
        self.assertNotIn("second line", result.out)

    def test_a_short_description_is_left_alone(self):
        result = run_cli("show", "/x", spec=one_path(
            {"responses": {"default": {"description": "List of things."}}}))
        self.assertIn("response:  List of things.", result.out)


class TestEmptyBodies(unittest.TestCase):
    """Three different things, each said in its own words."""

    def blocks(self, out):
        return [line for line in out.splitlines()
                if line.startswith("      (") or line.strip() == ""]

    def test_a_response_schema_with_no_named_fields_says_so(self):
        # 28 of the 265 responses that carry a schema flatten to zero lines --
        # a free-form object, say. The response branch had no fallback, so it
        # printed one blank line and the reader saw nothing at all.
        result = run_cli("show", "/x", spec=one_path({"responses": {"default": {
            "description": "Log settings.",
            "content": {"application/json": {"schema": {"type": "object"}}}}}}))
        self.assertIn("(no named fields)", result.out)
        self.assertNotIn("(no body)", result.out)

    def test_a_response_with_no_schema_still_says_no_body(self):
        result = run_cli("show", "/x", spec=one_path(
            {"responses": {"default": {"description": "Done."}}}))
        self.assertIn("(no body)", result.out)
        self.assertNotIn("(no named fields)", result.out)

    def test_a_request_body_with_no_named_fields_is_unchanged(self):
        result = run_cli("show", "/x", spec=one_path(
            {"requestBody": {"content": {"application/json": {
                "schema": {"type": "object"}}}}}, method="post"))
        self.assertIn("(no named fields)", result.out)

    def test_no_response_block_is_ever_a_bare_blank_line(self):
        result = run_cli("show", "/x", spec=one_path({"responses": {"default": {
            "content": {"application/json": {
                "schema": {"type": "object"}}}}}}))
        lines = result.out.splitlines()
        marker = lines.index("  response:")
        self.assertNotEqual(lines[marker + 1].strip(), "")


if __name__ == "__main__":
    unittest.main()
