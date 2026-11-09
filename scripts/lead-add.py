#!/usr/bin/env python3
"""Queue a Discord lead flag as a CRM record for n0me.

The bridge hands a lead-intake thread to this script once someone in the thread has
answered what company the lead is at and whether it is a product request. It does not
write the CRM database: n0me's tables are CRDT projections and the running service holds
the sync engine open, so a row inserted here would not replicate and could be
overwritten. Instead this appends one JSON file to the n0me inbox directory, which is a
file boundary - the only thing that survives both processes being up at once.

    python3 scripts/lead-add.py --features                    # what to offer
    python3 scripts/lead-add.py --company Seunzt \\
        --company-description 'runs iroh on ~400 devices' \\
        --domain seunzt.com --feature Authentication --body - <<'TXT'
    we run iroh on ~400 devices and the relay bill is getting silly
    TXT

The record shape (what the n0me importer is meant to read):

    schema      int     version of this file format, currently 2
    kind        str     "lead_intake"
    id          str     uuid4; the importer keys on it, so re-running is idempotent
    created_at  str     UTC ISO-8601, when the lead was captured (not when it synced)
    complete    bool    false when the intake stopped early (--partial)
    company     dict    name, description, domain - name is required
    person      dict    name, email, discord, github, url - optional, and usually taken
                        from the flagged message rather than asked
    feature_request dict|None
                        feature (id if it matched a current one, else the text given),
                        feature_title, body (the flagged message text), importance
                        (1 nice to have, 2 important, 3 blocking), requester, url.
                        null when the answer was "not a product request" (--no-feature)
    source      dict    where the flag came from: message_url, thread_url, reactors,
                        answered_by

A person, when present, is n0me's Contact with contact_type = Lead.

Exit codes: 0 written or dry run, 2 invalid input, 3 that company or contact already
exists.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_VERSION = 2
KIND = "lead_intake"

N0ME_HOME = Path.home() / "Library" / "Application Support" / "n0me"
DEFAULT_INBOX = N0ME_HOME / "inbox"
DEFAULT_DB = N0ME_HOME / "db.sqlite"

FREE_MAIL_DOMAINS = {
    "gmail.com",
    "googlemail.com",
    "outlook.com",
    "hotmail.com",
    "live.com",
    "yahoo.com",
    "icloud.com",
    "me.com",
    "proton.me",
    "protonmail.com",
}

IMPORTANCE_LABELS = {1: "nice to have", 2: "important", 3: "blocking"}


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Queue a lead captured from a Discord reaction for the n0me CRM.",
    )
    company = parser.add_argument_group("company (required - this is what the intake asks)")
    company.add_argument("--company", help="company name")
    company.add_argument(
        "--company-description",
        dest="company_description",
        help="what they do or what this is about, in the words people used",
    )
    company.add_argument(
        "--domain",
        help="company domain; taken from --email when unset, but never a free mail domain",
    )

    person = parser.add_argument_group("person (optional - usually read off the message)")
    person.add_argument("--person-name", dest="person_name")
    person.add_argument("--email")
    person.add_argument(
        "--discord",
        help="Discord profile link or handle; a bare snowflake becomes a profile link",
    )
    person.add_argument("--github", help="GitHub URL or bare username")
    person.add_argument("--url", help="their site, LinkedIn, or X profile")

    request = parser.add_argument_group("feature request")
    request.add_argument(
        "--feature",
        help="which product feature this is, by title or id (see --features)",
    )
    request.add_argument(
        "--no-feature",
        dest="no_feature",
        action="store_true",
        help="the answer was that this is not a product request",
    )
    request.add_argument(
        "--body",
        help="the feature request body: the flagged message text, verbatim. Pass '-' to read stdin, which is the safe form for quoted text",
    )
    request.add_argument(
        "--importance",
        type=int,
        choices=sorted(IMPORTANCE_LABELS),
        help="1 nice to have (default), 2 important, 3 blocking",
    )

    source = parser.add_argument_group("source")
    source.add_argument("--source-url", dest="source_url", help="jump link of the flagged message")
    source.add_argument("--thread-url", dest="thread_url", help="link of the intake thread")
    source.add_argument(
        "--reactor",
        action="append",
        default=[],
        help="who reacted to flag it; repeatable",
    )
    source.add_argument("--answered-by", dest="answered_by", help="whoever supplied the answers")

    parser.add_argument(
        "--inbox",
        default=os.environ.get("GROOKIE_LEAD_INBOX", str(DEFAULT_INBOX)),
        help=f"where to write the record (default: {DEFAULT_INBOX})",
    )
    parser.add_argument(
        "--db",
        default=os.environ.get("N0ME_DB", str(DEFAULT_DB)),
        help=f"n0me database to read features from and check for duplicates (default: {DEFAULT_DB})",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="queue it even if n0me already has that company or contact",
    )
    parser.add_argument(
        "--partial",
        action="store_true",
        help="the intake stopped early; marks the record incomplete",
    )
    parser.add_argument(
        "--features", action="store_true", help="list the current product features and exit"
    )
    parser.add_argument("--dry-run", dest="dry_run", action="store_true", help="print, write nothing")
    parser.add_argument("--list", action="store_true", help="list queued records and exit")
    return parser.parse_args(argv)


def open_db(path: Path) -> sqlite3.Connection | None:
    """Read-only, because the n0me service owns the write lock."""
    if not path.exists():
        return None
    try:
        return sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=2.0)
    except sqlite3.Error:
        return None


def list_features(db_path: Path) -> list[tuple[str, str, str]] | None:
    """(id, title, stage) for the product backlog, or None if n0me cannot be read."""
    conn = open_db(db_path)
    if conn is None:
        return None
    try:
        return conn.execute(
            "select id, title, stage from product_features order by priority desc, title"
        ).fetchall()
    except sqlite3.Error:
        return None
    finally:
        conn.close()


def resolve_feature(db_path: Path, wanted: str) -> tuple[str | None, str]:
    """Match what someone said to a current feature.

    Returns (id_or_None, title_to_store). An unmatched name is kept as text rather than
    dropped: a new feature is a real answer, and the importer can match it later.
    """
    features = list_features(db_path)
    if features is None:
        return None, wanted.strip()
    needle = wanted.strip().casefold()
    for feature_id, title, _stage in features:
        if feature_id == wanted.strip() or feature_id.startswith(wanted.strip()):
            return feature_id, title
    for feature_id, title, _stage in features:
        if title.strip().casefold() == needle:
            return feature_id, title
    return None, wanted.strip()


def normalize_url(value: str | None, prefix: str) -> str | None:
    """Store what the CRM already stores: full URLs, not bare handles."""
    if value is None:
        return None
    value = value.strip()
    if not value:
        return None
    if value.startswith(("http://", "https://")):
        return value
    if value.startswith("@"):
        value = value[1:]
    return f"{prefix.rstrip('/')}/{value}"


def normalize_discord(value: str | None) -> str | None:
    """A snowflake is only useful as a link a human can click."""
    if value is None:
        return None
    value = value.strip()
    if not value:
        return None
    if re.fullmatch(r"\d{15,25}", value):
        return f"https://discord.com/users/{value}"
    return value


def domain_from_email(email: str | None) -> str | None:
    if not email or "@" not in email:
        return None
    domain = email.rsplit("@", 1)[1].strip().lower()
    # A gmail.com "company" is not a company; leave it out rather than pollute Company.
    if domain in FREE_MAIL_DOMAINS:
        return None
    return domain or None


def read_body(args: argparse.Namespace) -> str | None:
    if args.body is None:
        return None
    if args.body != "-":
        return args.body.strip() or None
    return sys.stdin.read().strip() or None


def build_record(args: argparse.Namespace, body: str | None) -> dict:
    email = (args.email or "").strip().lower() or None
    person_name = (args.person_name or "").strip() or None
    domain = (args.domain or "").strip().lower() or domain_from_email(email) or None
    feature_request = None
    if not args.no_feature and args.feature:
        feature_id, title = resolve_feature(Path(args.db).expanduser(), args.feature)
        feature_request = {
            "feature": feature_id,
            "feature_title": title,
            "body": body,
            "importance": args.importance or 1,
            "requester": person_name or (args.reactor[0] if args.reactor else None),
            "url": args.source_url,
        }
    return {
        "schema": SCHEMA_VERSION,
        "kind": KIND,
        "id": str(uuid.uuid4()),
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace(
            "+00:00", "Z"
        ),
        "complete": not args.partial,
        "company": {
            "name": (args.company or "").strip(),
            "description": (args.company_description or "").strip() or None,
            "domain": domain,
        },
        "person": (
            {
                "name": person_name,
                "email": email,
                "discord": normalize_discord(args.discord),
                "github": normalize_url(args.github, "https://github.com/"),
                "url": normalize_url(args.url, "https://"),
            }
            if person_name or email or args.discord or args.github or args.url
            else None
        ),
        "feature_request": feature_request,
        "source": {
            "channel": "discord",
            "message_url": args.source_url,
            "thread_url": args.thread_url,
            "reactors": args.reactor,
            "answered_by": args.answered_by,
        },
    }


def validate(record: dict, args: argparse.Namespace, body: str | None) -> list[str]:
    problems = []
    if not record["company"]["name"]:
        problems.append("--company is required: the intake exists to capture the company")
    if not args.no_feature and not args.feature:
        problems.append(
            "answer the second question: --feature <one of --features> for a product "
            "request, or --no-feature when it is not one"
        )
    if not args.no_feature and args.feature and not body:
        problems.append(
            "a feature request needs --body: the flagged message text, verbatim "
            "('-' reads it from stdin, which survives quotes)"
        )
    if args.no_feature and args.feature:
        problems.append("--feature and --no-feature contradict each other")
    if args.no_feature and body:
        problems.append("--body was given with --no-feature: drop one of them")
    if not record["source"]["message_url"]:
        problems.append("no --source-url: nothing says where this came from")
    return problems


def find_existing(db_path: Path, record: dict) -> list[str]:
    """Readable descriptions of anything we would be duplicating.

    Read-only on purpose: this runs while the n0me service has the sync engine open, and
    a write would fail on a locked database anyway.
    """
    conn = open_db(db_path)
    if conn is None:
        return []
    found: list[str] = []
    try:
        company = record["company"]
        # Domains are identifiers on the company, not a column: see company_identifiers.
        if company["domain"]:
            rows = conn.execute(
                "select c.id, c.name from company_identifiers i"
                " join companies c on c.id = i.company_id"
                " where i.kind = 'domain' and lower(i.value) = ? limit 3",
                (company["domain"],),
            ).fetchall()
            found += [f"company id={r[0]} name={r[1]!r} domain={company['domain']}" for r in rows]
        if not found and company["name"]:
            rows = conn.execute(
                "select id, name from companies where lower(name) = ? limit 3",
                (company["name"].lower(),),
            ).fetchall()
            found += [f"company id={r[0]} name={r[1]!r}" for r in rows]

        person = record["person"] or {}
        clauses, values = [], []
        if person.get("email"):
            clauses.append("lower(email) = ?")
            values.append(person["email"].lower())
        if person.get("discord"):
            clauses.append("(lower(discord) = ? OR lower(discord) = ?)")
            values.extend(
                [person["discord"].lower(), person["discord"].split("/")[-1].lower()]
            )
        if person.get("github"):
            clauses.append("(lower(github) = ? OR lower(github) = ?)")
            values.extend(
                [person["github"].lower(), person["github"].split("/")[-1].lower()]
            )
        if clauses:
            rows = conn.execute(
                f"select id, name from people where {' or '.join(clauses)} limit 3",
                values,
            ).fetchall()
            found += [f"contact id={r[0]} name={r[1]!r}" for r in rows]
    except sqlite3.Error:
        # No companies/people table, or the service is mid-migration: not a reason to
        # lose the lead, so report what was found rather than failing.
        return found
    finally:
        conn.close()
    return found


def write_record(inbox: Path, record: dict) -> Path:
    inbox.mkdir(parents=True, exist_ok=True)
    target = inbox / f"lead-{record['id']}.json"
    handle, tmp_name = tempfile.mkstemp(dir=inbox, prefix=".lead-", suffix=".json")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as handle:
            json.dump(record, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
        os.chmod(tmp_name, 0o600)
        os.replace(tmp_name, target)
    except BaseException:
        Path(tmp_name).unlink(missing_ok=True)
        raise
    return target


def describe(record: dict) -> str:
    company = record["company"]["name"]
    request = record["feature_request"]
    if request:
        importance = IMPORTANCE_LABELS.get(request["importance"], "")
        detail = f" — feature request: {request['feature_title']} ({importance})"
    else:
        detail = " — no product request"
    state = "" if record["complete"] else " (partial intake)"
    return f"{company}{detail}{state}"


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    inbox = Path(args.inbox).expanduser()
    db_path = Path(args.db).expanduser()

    if args.features:
        features = list_features(db_path)
        if features is None:
            print(
                f"cannot read features from {db_path}; ask for the feature by name and "
                "record the text as given",
                file=sys.stderr,
            )
            return 2
        if not features:
            print("n0me has no product features yet; ask for the feature by name")
            return 0
        print("current product features (n0me):")
        for _feature_id, title, stage in features:
            print(f"  {title}  [{stage}]")
        return 0

    if args.list:
        records = sorted(inbox.glob("lead-*.json")) if inbox.exists() else []
        if not records:
            print(f"inbox {inbox} is empty")
            return 0
        print(f"{len(records)} record(s) queued in {inbox}:")
        for path in records:
            print(f"  {path.name}")
        return 0

    body = read_body(args)
    record = build_record(args, body)
    problems = validate(record, args, body)
    if problems:
        for problem in problems:
            print(f"not queued: {problem}", file=sys.stderr)
        return 2

    if not args.force:
        duplicates = find_existing(db_path, record)
        if duplicates:
            print(
                "not queued: n0me already has this -\n  "
                + "\n  ".join(duplicates)
                + "\nupdate what is there instead, or pass --force to queue it anyway",
                file=sys.stderr,
            )
            return 3

    if args.dry_run:
        print(json.dumps(record, ensure_ascii=False, indent=2, sort_keys=True))
        print(f"\ndry run: would queue {describe(record)}", file=sys.stderr)
        return 0

    target = write_record(inbox, record)
    print(f"queued {describe(record)}")
    print(f"record: {target}")
    print("status: waiting for n0me to import it - it is not in Contacts yet")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
