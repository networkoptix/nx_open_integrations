#!/usr/bin/env python3
# Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
"""
Query the Nx REST API spec (docs/vX_api_spec.json) from the command line.

The spec is a multi-megabyte OpenAPI 3.0.2 document. Reading it whole is
wasteful and grepping it gives you quoted fragments without their method, their
parameters or their deprecation status. This prints the part you asked for.

  # Which paths mention "device"?
  python3 tools/spec_lookup.py find device

  # Everything about one path: methods, parameters, request and response fields.
  python3 tools/spec_lookup.py show /rest/v4/devices

  # Only a single method. Exits 1 if the path has no such method.
  python3 tools/spec_lookup.py show /rest/v4/devices --method post

  # Nested fields are printed 3 levels deep; anything cut off says so.
  python3 tools/spec_lookup.py show /rest/v4/servers --depth 6

  # Anything deprecated (check before you build on it).
  python3 tools/spec_lookup.py deprecated

  # Who is allowed to call it. This spec puts that in x-permissions, not in
  # `security`, which is null throughout.
  python3 tools/spec_lookup.py permissions site/database

  # Has the vendored copy drifted from a live server?
  python3 tools/spec_lookup.py stale --against https://192.168.1.10:7001/... --insecure
  python3 tools/spec_lookup.py stale --against /tmp/live_spec.json

In `show`, a field marked `*` is required and a type printed as `?` means the
spec does not state one. A `oneOf` prints as a union: `integer|string`.

Tests live beside this file: `cd tools && python3 -m unittest test_spec_lookup`.

Exit codes, so a script can branch on them:
  0  the lookup succeeded (or `stale` found no path/method drift)
  1  the lookup found nothing (or `stale` found drift)
  2  the spec could not be read: missing file, bad JSON, not an OpenAPI document
"""

import argparse
import json
import os
import sys

METHODS = ("get", "post", "put", "patch", "delete", "head", "options")

# How many levels of nested fields `show` prints. 3 covers every field in
# the vendored spec; deeper specs say so on the line where they are cut.
DEFAULT_DEPTH = 3

# Enum values shown inline before the list is cut. Long ones are cut, never
# dropped: the count that follows tells the reader to open the spec.
ENUM_PREVIEW = 8

# A list of a list of a list is already unreadable, and a schema whose items
# point back at itself would unwrap forever.
MAX_ARRAY_NESTING = 5

# The vendored spec is ~1.8 MB. A reference an order of magnitude larger is a
# wrong URL, not a spec, and reading it whole would be the only thing that
# hurt. 32 MB leaves room for a much bigger API than this one.
MAX_DOWNLOAD = 32 * 1024 * 1024

# Prose from the spec is printed inside an indented block, so it has to fit on
# one line of it.
SUMMARY_WIDTH = 100


class SpecError(Exception):
    """A spec that cannot be read or is not an OpenAPI document."""


def one_line(text, limit=SUMMARY_WIDTH):
    """The first line of a description, trimmed to fit an indented block.

    Descriptions in this spec wrap. Printed verbatim, the continuation lands in
    column 0 and the block it belongs to stops reading as one thing.
    """
    if not text:
        return ""
    # Unwrap rather than take the first line: a wrapped description is one
    # sentence, and dropping its tail silently is the failure this tool is
    # meant to prevent. What the limit cuts is marked with an ellipsis.
    flat = " ".join(str(text).split())
    return flat if len(flat) <= limit else flat[:limit].rstrip() + "..."


def load_spec(path):
    """Read an OpenAPI document, or raise SpecError with a one-line reason.

    A traceback here exits 1 -- the same code as "found nothing" -- so a caller
    branching on the exit code would read a corrupt spec as an empty result.
    """
    try:
        with open(path, "r", encoding="utf-8") as handle:
            document = json.load(handle)
    except OSError as error:
        raise SpecError("{} cannot be read: {}".format(path, error))
    except ValueError as error:
        raise SpecError("{} is not valid JSON: {}".format(path, error))
    if not isinstance(document, dict) or "paths" not in document:
        raise SpecError(
            "{} is not an OpenAPI document: no top-level 'paths'".format(path))
    return document


def resolve(spec, node, _depth=0):
    """Follow a local $ref one level at a time, guarding against cycles."""
    if _depth > 20 or not isinstance(node, dict):
        return node if isinstance(node, dict) else {}
    ref = node.get("$ref")
    if not ref or not ref.startswith("#/"):
        return merge_all_of(spec, node, _depth)
    target = spec
    for part in ref[2:].split("/"):
        # RFC 6901 escaping: "~1" is "/" and "~0" is "~", in that order.
        part = part.replace("~1", "/").replace("~0", "~")
        if not isinstance(target, dict) or part not in target:
            return {"$ref": ref}    # dangling; keep it so callers can say so
        target = target[part]
    return resolve(spec, target, _depth + 1)


def merge_all_of(spec, node, _depth=0):
    """Collapse an allOf into one schema.

    allOf is an intersection: the caller must satisfy every member, so the
    fields they send are the union of the members' fields. Left unmerged the
    node has no `type` and no `properties`, and a whole body renders as "?".
    """
    if not isinstance(node, dict) or "allOf" not in node or _depth > 5:
        return node
    merged = {key: value for key, value in node.items() if key != "allOf"}
    properties = dict(merged.get("properties") or {})
    required = list(merged.get("required") or [])
    for raw in node["allOf"]:
        member = merge_all_of(spec, resolve(spec, raw), _depth + 1)
        if not isinstance(member, dict):
            continue
        properties.update(member.get("properties") or {})
        for name in member.get("required") or []:
            if name not in required:
                required.append(name)
    if properties:
        merged["properties"] = properties
    if required:
        merged["required"] = required
    merged.setdefault("type", "object")
    return merged


def type_name(spec, node, _depth=0):
    """The type a caller must actually send or expect.

    Returns "?" when the spec does not say, never a guess. A oneOf becomes the
    union of its members -- "integer|string" -- because printing such a field
    as a single type is worse than printing nothing: the reader acts on it.
    """
    node = resolve(spec, node)
    if not isinstance(node, dict) or _depth > 5:
        return "?"
    if "$ref" in node:
        # resolve() hands back the pointer it could not follow. Printing "?"
        # here would blame the spec for what is really a broken reference.
        return "<unresolved $ref: {}>".format(node["$ref"])
    members = node.get("oneOf") or node.get("anyOf")
    if members:
        names = []
        for member in members:
            name = type_name(spec, member, _depth + 1)
            if name not in names:
                names.append(name)
        return "|".join(names) or "?"
    extra = node.get("additionalProperties")
    if extra is not None and "properties" not in node:
        # A string-keyed map. The spec states the value type even though it
        # cannot state the keys, and that is the half the caller needs.
        return "map<{}>".format(
            type_name(spec, extra, _depth + 1) if isinstance(extra, dict) else "?")

    kind = node.get("type") or "?"
    values = node.get("enum")
    if values:
        shown = ["{}".format(v) for v in values[:ENUM_PREVIEW]]
        extra = len(values) - len(shown)
        return "{}{{{}{}}}".format(kind, "|".join(shown),
                                   "|+{} more".format(extra) if extra else "")
    return kind


def schema_fields(spec, schema, prefix="", depth=0, max_depth=DEFAULT_DEPTH):
    """Flatten a schema into 'field: type' lines.

    Required fields carry a '*'. Anything the depth limit cuts off is named on
    a line of its own: output that silently omits fields reads as complete.
    """
    schema = resolve(spec, schema)
    if depth > max_depth or not isinstance(schema, dict):
        return []

    # Unwrap a list into the shape of its items without spending a depth
    # level: "[].name" is one field, not two. Iterative and capped, because a
    # self-referential array schema would otherwise recurse until Python quit.
    unwrapped = 0
    while (schema.get("type") == "array" and "items" in schema
           and unwrapped < MAX_ARRAY_NESTING):
        schema = resolve(spec, schema["items"])
        prefix += "[]."
        unwrapped += 1

    lines = []
    # An object schema lists its mandatory children by name. A caller who cannot
    # see which fields are required cannot build a valid request at all.
    required = set(schema.get("required") or [])
    for name, raw in (schema.get("properties") or {}).items():
        prop = resolve(spec, raw)
        kind = type_name(spec, prop)
        mark = "*" if name in required else ""

        # Descend into whatever actually holds the fields: an object's own
        # properties, or an array's item schema. Stopping at "array<object>"
        # hid every field of every nested list in the spec.
        child, child_prefix = prop, prefix + name + "."
        if kind.startswith("map<"):
            child = resolve(spec, prop.get("additionalProperties") or {})
            child_prefix = prefix + name + "{}."
        elif kind == "array":
            item = resolve(spec, prop.get("items", {}))
            kind = "array<{}>".format(type_name(spec, item))
            child, child_prefix = item, prefix + name + "[]."

        note = " (deprecated)" if prop.get("deprecated") else ""
        lines.append("      {}{}{}: {}{}".format(prefix, name, mark, kind, note))
        if isinstance(child, dict) and ("properties" in child
                                        or child.get("type") == "object"):
            below = schema_fields(spec, child, child_prefix, depth + 1, max_depth)
            if below:
                lines.extend(below)
            elif child.get("properties"):
                lines.append(
                    "      {}... {} more field(s) truncated; use --depth {}"
                    .format(child_prefix, len(child["properties"]), max_depth + 1))
    return lines


def first_schema(spec, body_or_response):
    content = resolve(spec, body_or_response or {}).get("content") or {}
    for media in ("application/json", "*/*"):
        if media in content:
            return content[media].get("schema")
    return (next(iter(content.values()), {}) or {}).get("schema")


def cmd_find(spec, args):
    needle = args.keyword.lower()
    hits = sorted(p for p in spec.get("paths", {}) if needle in p.lower())
    if not hits:
        print("No path matches {!r}.".format(args.keyword), file=sys.stderr)
        return 1
    width = max(len(p) for p in hits)
    for path in hits:
        entry = spec["paths"][path]
        methods = [m.upper() for m in METHODS
                   if isinstance(entry, dict) and m in entry]
        print("{:<{w}}  {}".format(path, " ".join(methods), w=width))
    print("\n{} path(s).".format(len(hits)))
    return 0


def cmd_show(spec, args):
    entry = spec.get("paths", {}).get(args.path)
    if entry is None:
        print("Path {!r} is not in the spec. Try: spec_lookup.py find {}"
              .format(args.path, args.path.strip("/").split("/")[-1]), file=sys.stderr)
        return 1

    print("=" * 72)
    print(args.path)
    print("=" * 72)
    print("legend:  * = required   ? = the spec does not state a type")

    wanted = [args.method] if args.method else METHODS
    shown = 0
    for method in wanted:
        operation = entry.get(method)
        if not operation:
            continue
        shown += 1

        flag = "   ** DEPRECATED **" if operation.get("deprecated") else ""
        print("\n{}{}".format(method.upper(), flag))
        if operation.get("summary"):
            print("  {}".format(one_line(operation["summary"])))

        # This spec carries permissions in an extension, not in `security`,
        # which is null everywhere. Nearly every operation has one, and several
        # say more than a role name: "Administrator with a fresh session"
        # means an old token will not do.
        if operation.get("x-permissions"):
            print("\n  permissions: {}".format(operation["x-permissions"]))

        params = (entry.get("parameters") or []) + (operation.get("parameters") or [])
        if params:
            print("\n  parameters:")
            for raw in params:
                param = resolve(spec, raw)
                schema = resolve(spec, param.get("schema", {}))
                print("      {:<28} {:<8} {}{}".format(
                    param.get("name", "?"),
                    param.get("in", "?"),
                    schema.get("type", "?"),
                    "  (required)" if param.get("required") else ""))

        body = first_schema(spec, operation.get("requestBody"))
        if body:
            print("\n  request body:")
            print("\n".join(schema_fields(spec, body, max_depth=args.depth))
                  or "      (no named fields)")

        # This spec documents every response under "default", none under a 2xx
        # code. Accept both: filtering to 2xx silently printed nothing at all,
        # which reads as "this endpoint returns no body".
        for code in sorted(operation.get("responses") or {}):
            if not (code == "default" or code.startswith("2")):
                continue
            response = operation["responses"][code]
            schema = first_schema(spec, response)
            label = "response" if code == "default" else "response {}".format(code)
            description = one_line(resolve(spec, response).get("description"))
            print("\n  {}:{}".format(label,
                                     "  " + description if description else ""))
            # Three different answers, and the reader acts differently on
            # each: no schema at all, a schema with no named fields (a
            # free-form object), or the fields themselves.
            if not schema:
                print("      (no body)")
            else:
                print("\n".join(schema_fields(spec, schema,
                                               max_depth=args.depth))
                      or "      (no named fields)")

    if not shown:
        print("{!r} has no {} operation. It has: {}".format(
            args.path, (args.method or "documented").upper(),
            ", ".join(m.upper() for m in METHODS if m in entry) or "none"),
            file=sys.stderr)
        return 1
    return 0


def cmd_permissions(spec, args):
    """Who may call the paths matching a keyword."""
    needle = args.keyword.lower()
    rows = []
    for path, entry in sorted(spec.get("paths", {}).items()):
        if needle not in path.lower():
            continue
        for method in METHODS:
            operation = entry.get(method)
            if isinstance(operation, dict):
                rows.append((method.upper(), path,
                             operation.get("x-permissions", "(not stated)")))
    if not rows:
        print("No path matches {!r}.".format(args.keyword), file=sys.stderr)
        return 1
    width = max(len(p) for _m, p, _x in rows)
    for method, path, perm in rows:
        print("{:<7} {:<{w}}  {}".format(method, path, perm, w=width))
    print("\n{} operation(s). A permission naming a 'fresh session' means a "
          "token from an old login is refused.".format(len(rows)))
    return 0


def cmd_deprecated(spec, _args):
    found = False
    for path, entry in sorted(spec.get("paths", {}).items()):
        for method in METHODS:
            operation = entry.get(method)
            if isinstance(operation, dict) and operation.get("deprecated"):
                found = True
                print("{:<6} {}".format(method.upper(), path))
                if operation.get("description"):
                    print("       {}".format(one_line(operation["description"])))
    if not found:
        print("Nothing in the spec is marked deprecated.")
    return 0


def _load_reference(source, insecure):
    """Load the comparison spec from a local path or an http(s) URL."""
    if not source.startswith(("http://", "https://")):
        return load_spec(source)

    import ssl
    import urllib.request

    context = None
    if insecure:
        # Lab servers present a self-signed certificate; this is opt-in only.
        context = ssl.create_default_context()
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
    with urllib.request.urlopen(source, timeout=30, context=context) as response:
        payload = response.read(MAX_DOWNLOAD + 1)
    if len(payload) > MAX_DOWNLOAD:
        raise SpecError(
            "the response is too large (over {} MB) -- is {} really a spec?"
            .format(MAX_DOWNLOAD // (1024 * 1024), source))
    return json.loads(payload.decode("utf-8"))


def diff_specs(vendored, reference):
    """Compare two OpenAPI documents. Returns a dict of what changed."""
    ours = vendored.get("paths", {})
    theirs = reference.get("paths", {})

    def operations(paths, path):
        return {m for m in paths.get(path, {}) if m in METHODS}

    shared = sorted(set(ours) & set(theirs))
    changed = []
    for path in shared:
        gained = operations(theirs, path) - operations(ours, path)
        lost = operations(ours, path) - operations(theirs, path)
        if gained or lost:
            changed.append((path, sorted(gained), sorted(lost)))

    newly_deprecated = []
    for path in shared:
        for method in sorted(operations(ours, path) & operations(theirs, path)):
            was = bool(ours[path][method].get("deprecated"))
            now = bool(theirs[path][method].get("deprecated"))
            if now and not was:
                newly_deprecated.append((method.upper(), path))

    return {
        "added": sorted(set(theirs) - set(ours)),
        "removed": sorted(set(ours) - set(theirs)),
        "changed": changed,
        "newly_deprecated": newly_deprecated,
        "title_ours": vendored.get("info", {}).get("title"),
        "title_theirs": reference.get("info", {}).get("title"),
    }


def cmd_stale(spec, args):
    try:
        reference = _load_reference(args.against, args.insecure)
    except Exception as error:                      # network, TLS, bad JSON
        print("ERROR: could not read the comparison spec from {}: {}"
              .format(args.against, error), file=sys.stderr)
        if not args.insecure and args.against.startswith("https://"):
            print("       A lab server's self-signed certificate needs --insecure.",
                  file=sys.stderr)
        return 2

    result = diff_specs(spec, reference)

    if result["title_ours"] != result["title_theirs"]:
        print("NOTE: titles differ -- vendored {!r} vs reference {!r}. Make sure "
              "you are comparing against the same API."
              .format(result["title_ours"], result["title_theirs"]))
        print()

    for label, rows in (("paths ADDED upstream (missing from the vendored copy)",
                         result["added"]),
                        ("paths REMOVED upstream (still in the vendored copy)",
                         result["removed"])):
        if rows:
            print("{} -- {}:".format(label, len(rows)))
            for path in rows:
                print("    {}".format(path))
            print()

    if result["changed"]:
        print("methods changed on existing paths -- {}:".format(len(result["changed"])))
        width = max(len(p) for p, _g, _l in result["changed"])
        for path, gained, lost in result["changed"]:
            detail = []
            if gained:
                detail.append("+" + ",".join(m.upper() for m in gained))
            if lost:
                detail.append("-" + ",".join(m.upper() for m in lost))
            print("    {:<{w}}  {}".format(path, " ".join(detail), w=width))
        print()

    if result["newly_deprecated"]:
        print("newly DEPRECATED upstream -- {}:".format(len(result["newly_deprecated"])))
        for method, path in result["newly_deprecated"]:
            print("    {:<6} {}".format(method, path))
        print()

    total = (len(result["added"]) + len(result["removed"])
             + len(result["changed"]) + len(result["newly_deprecated"]))
    if total == 0:
        # Say only what was actually compared. diff_specs looks at path names,
        # method names and the deprecated flag -- nothing else -- so claiming
        # the two specs "match" would hide a changed parameter or schema.
        print("Same paths and methods across {} path(s), and nothing newly "
              "deprecated.\nParameters, schemas and x-permissions are NOT "
              "compared; use `show` to check a specific operation."
              .format(len(spec.get("paths", {}))))
        return 0

    print("{} difference(s). The vendored docs/v4_api_spec.json is out of date; "
          "refresh it from the server's API tool.".format(total))
    return 1


def default_spec_path():
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(os.path.dirname(here), "docs", "v4_api_spec.json")


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Query the Nx REST API spec.",
        epilog="Endpoints in a sample must come from here, never from memory.")
    parser.add_argument("--spec", default=default_spec_path(),
                        help="path to v4_api_spec.json")
    sub = parser.add_subparsers(dest="command", required=False)

    found = sub.add_parser("find", help="list paths containing a keyword")
    found.add_argument("keyword")
    found.set_defaults(run=cmd_find)

    shown = sub.add_parser("show", help="show one path in full")
    shown.add_argument("path")
    shown.add_argument("--method", type=str.lower, choices=METHODS,
                       metavar="{" + ",".join(METHODS) + "}",
                       help="one HTTP method; case does not matter")
    shown.add_argument("--depth", type=int, default=DEFAULT_DEPTH,
                       help="levels of nested fields to print "
                            "(default: %(default)s)")
    shown.set_defaults(run=cmd_show)

    dep = sub.add_parser("deprecated", help="list every deprecated operation")
    dep.set_defaults(run=cmd_deprecated)

    perm = sub.add_parser("permissions",
                          help="who may call the paths matching a keyword")
    perm.add_argument("keyword")
    perm.set_defaults(run=cmd_permissions)

    stale = sub.add_parser(
        "stale", help="compare the vendored spec against a live or downloaded one",
        description="The vendored docs/v4_api_spec.json is a snapshot and drifts "
                    "as new VMS versions ship. This reports what changed.")
    stale.add_argument("--against", required=True, metavar="PATH_OR_URL",
                       help="the reference spec: a local file, or an http(s) URL. "
                            "Export it from the server's built-in API tool -- this "
                            "script does not guess an endpoint.")
    stale.add_argument("--insecure", action="store_true",
                       help="skip TLS verification (lab servers use self-signed certs)")
    stale.set_defaults(run=cmd_stale)

    args = parser.parse_args(argv)

    if not args.command:
        parser.error("a command is required: "
                     + ", ".join(sorted(sub.choices)))
    try:
        spec = load_spec(args.spec)
    except SpecError as error:
        print("ERROR: {}\n       Pass --spec with the path to v4_api_spec.json."
              .format(error), file=sys.stderr)
        return 2
    return args.run(spec, args)


if __name__ == "__main__":
    sys.exit(main())
