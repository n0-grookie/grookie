#!/usr/bin/env python3
"""Queue a Discord lead flag as a CRM record for n0me.

The bridge hands a lead-intake thread to this script once someone in the thread has
answered who the lead is. It does not write the CRM database: n0me's tables are CRDT
projections and the running service holds the sync engine open, so a row inserted here
would not replicate and could be overwritten. Instead this appends one JSON file to the
n0me inbox directory, which is a file boundary - the only thing that survives both
processes being up at once.

    python3 scripts/lead-add.py --name 'Ivon Jevnikar' --company Seunzt \\
        --email ivon@seunzt.com --description 'asked about iroh relay quotas' \\
        --source-url https://discord.com/channels/G/C/M

The record shape (what the n0me importer is meant to read):

    schema      int     version of this file format, currently 1
    kind        str     "lead_contact"
    id          str     uuid4; the importer keys on it, so re-running is idempotent
    created_at  str     UTC ISO-8601, when the lead was captured (not when it synced)
    complete    bool    false when the intake stopped early (--partial)
    person      dict    name, email, discord, github, url, description  (n0me: a Contact
                        with contact_type = Lead)
    company     dict    name, domain - null when nobody knew the company
    source      dict    where the flag came from: message_url, thread_url, reactors,
                        answered_by

Exit codes: 0 written or dry run, 2 invalid input, 3 that contact already exists.
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

SCHEMA_VERSION = 1
KIND = "lead_contact"

N0ME_HOME = Path.home() / "Library" / "Application Support" / "n0me"
DEFAULT_INBOX = N0ME_HOME / "inbox"
DEFAULT_DB = N0ME_HOME / "db.sqlite"

CONTACT_FIELDS = ("name", "email", "discord", "github", "url", "description")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Queue a lead captured from a Discord reaction for the n0me CRM.",
    )
    person = parser.add_argument_group("person (a Contact flagged as Lead)")
    person.add_argument(
        "--name",
        help="who the lead is; required unless --list",
    )
    person.add_argument("--email")
    person.add_argument(
        "--discord",
        help="Discord profile link or handle; a bare snowflake becomes a profile link",
    )
    person.add_argument("--github", help="GitHub URL or bare username")
    person.add_argument("--url", help="their site, LinkedIn, or X profile")
    person.add_argument(
        "--description",
        help="who they are and what they want - include the context, not just the name",
    )

    company = parser.add_argument_group("company")
    company.add_argument("--company", help="company name")
    company.add_argument("--domain", help="company domain; guessed from --email if unset")

    source = parser.add_argument_group("source")
    source.add_argument("--source-url", help="jump link of the flagged message")
    source.add_argument("--thread-url", help="link of the intake thread")
    source.add_argument(
        "--reactor",
        action="append",
        default=[],
        help="who reacted to flag it; repeatable",
    )
    source.add_argument("--answered-by", help="whoever supplied the answers")

    parser.add_argument(
        "--inbox",
        default=os.environ.get("GROOKIE_LEAD_INBOX", str(DEFAULT_INBOX)),
        help=f"where to write the record (default: {DEFAULT_INBOX})",
    )
    parser.add_argument(
        "--db",
        default=os.environ.get("N0ME_DB", str(DEFAULT_DB)),
        help=f"n0me database to check for an existing contact (default: {DEFAULT_DB})",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="queue it even if the contact already exists in the CRM",
    )
    parser.add_argument(
        "--partial",
        action="store_true",
        help="the intake stopped early; marks the record incomplete",
    )
    parser.add_argument("--dry-run", action="store_true", help="print, write nothing")
    parser.add_argument("--list", action="store_true", help="list queued records and exit")
    return parser.parse_args(argv)


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


def domain_from_email(email: str | None) -> str | None:
    if not email or "@" not in email:
        return None
    domain = email.rsplit("@", 1)[1].strip().lower()
    # A gmail.com "company" is not a company; leave it out rather than pollute Company.
    if domain in FREE_MAIL_DOMAINS:
        return None
    return domain or None


def build_record(args: argparse.Namespace) -> dict:
    github = normalize_url(args.github, "https://github.com/")
    website = normalize_url(args.url, "https://")
    email = (args.email or "").strip().lower() or None
    company_name = (args.company or "").strip() or None
    domain = (args.domain or "").strip().lower() or domain_from_email(email) or None
    return {
        "schema": SCHEMA_VERSION,
        "kind": KIND,
        "id": str(uuid.uuid4()),
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace(
            "+00:00", "Z"
        ),
        "complete": not args.partial,
        "person": {
            "name": (args.name or "").strip(),
            "email": email,
            "discord": normalize_discord(args.discord),
            "github": github,
            "url": website,
            "description": (args.description or "").strip() or None,
        },
        "company": {"name": company_name, "domain": domain} if company_name or domain else None,
        "source": {
            "channel": "discord",
            "message_url": args.source_url,
            "thread_url": args.thread_url,
            "reactors": args.reactor,
            "answered_by": args.answered_by,
        },
    }


def validate(record: dict) -> list[str]:
    problems = []
    if not record["person"]["name"]:
        problems.append("--name is required and cannot be empty")
    person = record["person"]
    contacts = [person[field] for field in ("email", "discord", "github", "url")]
    if not any(contacts) and record["company"] is None:
        problems.append(
            "nothing to act on: give at least one of --email/--discord/--github/--url "
            "or --company, or do not queue the lead"
        )
    if not person["description"] and not record["source"]["message_url"]:
        problems.append("no --description and no --source-url: nothing says where this came from")
    return problems


def find_existing(db_path: Path, record: dict) -> str | None:
    """Return a readable description of a contact we would be duplicating.

    Read-only on purpose: this runs while the n0me service has the sync engine open,
    and a write would fail on a locked database anyway.
    """
    if not db_path.exists():
        return None
    person = record["person"]
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=2.0)
    except sqlite3.Error:
        return None
    try:
        clauses, values = [], []
        if person["email"]:
            clauses.append("lower(email) = ?")
            values.append(person["email"].lower())
        if person["discord"]:
            clauses.append("(lower(discord) = ? OR lower(discord) = ?)")
            values.extend([person["discord"].lower(), person["discord"].split("/")[-1].lower()])
        if person["github"]:
            clauses.append("(lower(github) = ? OR lower(github) = ?)")
            values.extend([person["github"].lower(), person["github"].split("/")[-1].lower()])
        if not clauses:
            return None
        rows = conn.execute(
            f"select id, name, email, discord, github from people where {' or '.join(clauses)}",
            values,
        ).fetchall()
    except sqlite3.Error:
        # No people table, or the service is mid-migration: not a reason to lose the lead.
        return None
    finally:
        conn.close()
    if not rows:
        return None
    first = rows[0]
    extra = f" (+{len(rows) - 1} more)" if len(rows) > 1 else ""
    return f"id={first[0]} name={first[1]!r} email={first[2]!r}{extra}"


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
    person = record["person"]
    company = record["company"]["name"] if record["company"] else "no company"
    state = "" if record["complete"] else " (partial intake)"
    return f"{person['name']} — {company}{state}"


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    inbox = Path(args.inbox).expanduser()

    if args.list:
        records = sorted(inbox.glob("lead-*.json")) if inbox.exists() else []
        if not records:
            print(f"inbox {inbox} is empty")
            return 0
        print(f"{len(records)} record(s) queued in {inbox}:")
        for path in records:
            print(f"  {path.name}")
        return 0

    if not (args.name or "").strip():
        print("not queued: --name is required (only --list runs without it)", file=sys.stderr)
        return 2

    record = build_record(args)
    problems = validate(record)
    if problems:
        for problem in problems:
            print(f"not queued: {problem}", file=sys.stderr)
        return 2

    if not args.force:
        existing = find_existing(Path(args.db).expanduser(), record)
        if existing:
            print(
                f"not queued: the CRM already has this contact - {existing}\n"
                "update that contact instead, or pass --force to queue it anyway",
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
