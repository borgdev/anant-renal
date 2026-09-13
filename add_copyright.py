#!/usr/bin/env python3

#****************************************************************************
#*
#* Copyright (c) 2026 AnantHQ Inc.
#* All Rights Reserved.
#*
#* This software is licensed, not sold.
#*
#* The contents of this file constitute confidential and proprietary
#* information belonging exclusively to AnantHQ Inc.
#*
#* This source code incorporates proprietary algorithms, software architecture,
#* business logic, computational methods, optimization techniques,
#* workflows, data structures, APIs, and implementation details that are
#* protected by copyright law, patent law, trade secret law, and
#* international intellectual property treaties.
#*
#* Except as expressly permitted by a written license agreement,
#* no person or organization may:
#*
#*   • Copy or reproduce this software.
#*   • Modify or create derivative works.
#*   • Reverse engineer, decompile, or disassemble.
#*   • Benchmark or publicly disclose performance.
#*   • Redistribute, sublicense, lease, rent, or sell.
#*   • Use this software for competitive analysis.
#*   • Disclose any implementation details.
#*
#* Any unauthorized use is strictly prohibited and may result in
#* civil damages, injunctive relief, criminal prosecution,
#* and all other remedies available under applicable law.
#*
#******************************************************************************/

"""
Add the AnantHQ copyright header to all source files in the repository.

Usage:
    python scripts/add_copyright.py              # Apply to all source files
    python scripts/add_copyright.py --dry-run    # Preview without modifying
    python scripts/add_copyright.py --check      # Exit 1 if any file is missing/stale

The header is read from copyright.md at the repository root. Editing that file
changes the header every source file receives, so this script is also the way a
legal-entity rename is propagated.

Two distinct repairs are performed:

  * a file with no header gets one prepended;
  * a file whose header names a DIFFERENT legal entity has that one line
    corrected in place, so the block, its position, and its comment style are
    left untouched and no second header is ever stacked on top of the first;
  * a file that already carries a compliant notice in some other form (for
    example a one-line notice fused into its own docblock) is left alone, since
    prepending would duplicate the notice and rewriting the block would destroy
    documentation.

Idempotent: a file that already complies with copyright.md is left alone.
"""

import argparse
import os
import sys
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
# Walk up until we find copyright.md — supports running from the repo root or from scripts/
while not (REPO_ROOT / "copyright.md").exists() and REPO_ROOT != REPO_ROOT.parent:
    REPO_ROOT = REPO_ROOT.parent

# ── Header source ──────────────────────────────────────────────────────────
HEADER_FILE = REPO_ROOT / "copyright.md"

# ── File types and their comment styles ────────────────────────────────────
# Value: "/*" = C-style block comment (header used as-is),
#        "#"  = hash line comments,
#        "--" = dash line comments (SQL / Lua),
#        "html" = HTML block comment.
COMMENT_STYLES = {
    # C-style block comments (uses header as-is)
    ".rs":     "/*",
    ".ts":     "/*",
    ".tsx":    "/*",
    ".js":     "/*",
    ".jsx":    "/*",
    ".mjs":    "/*",
    ".cjs":    "/*",
    ".mts":    "/*",
    ".cts":    "/*",
    ".css":    "/*",
    ".proto":  "/*",
    # HTML block comment
    ".html":   "html",
    ".htm":    "html",
    # Hash-style line comments
    ".py":     "#",
    ".sh":     "#",
    ".yml":    "#",
    ".yaml":   "#",
    ".toml":   "#",
    ".ini":    "#",
    ".cfg":    "#",
    ".env":    "#",
    # Dash-style line comments
    ".sql":    "--",
    ".lua":    "--",
    # Dockerfile
    "Dockerfile": "#",
    "Dockerfile.*": "#",
    # Makefile
    "Makefile": "#",
    "Makefile.*": "#",
}

# ── Exclusion patterns ─────────────────────────────────────────────────────
EXCLUDE_DIRS = {
    "target",
    "node_modules",
    ".git",
    ".harness",
    "dist",
    ".next",
    "coverage",
    ".vscode",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    "protoc3/include",  # Google's own protobuf definitions
}

EXCLUDE_FILE_PATTERNS = [
    re.compile(r"src/ingest/connectors/specs/.*\.toml$"),  # 700+ data files
    re.compile(r"\./copyright\.md$"),        # The header source itself
    re.compile(r"\./movies\.json$"),         # Movie database (data, not source)
    re.compile(r"\./nango_providers\.yaml$"),# Third-party vendor data
    re.compile(r"(^|/)\.env(\.|$)"),         # Local secrets, never in the repo
    re.compile(r"native/liquid-wasm/pkg/"),  # wasm-pack generated bundle
]

# ── Header reconciliation ──────────────────────────────────────────────────
# The ownership entity is the one part of the header that changes when the
# legal entity changes. Everything else is stable boilerplate, which is what
# makes a targeted, in-place correction possible instead of a blind prepend.
ENTITY_PATTERN = re.compile(r"information belonging exclusively to (.+?)\s*$", re.MULTILINE)

# The header never sits deeper in a file than this. Scanning a fixed window
# bounds the correction so it can never reach prose further down the file.
HEADER_SCAN_LINES = 40


def load_header_text() -> str:
    """Read the copyright header block from copyright.md."""
    with open(HEADER_FILE, "r") as f:
        return f.read()


def to_line_style(block: str, prefix: str) -> str:
    """Convert a /* */ block comment to `prefix` line comments (e.g. # or --)."""
    result = []
    for raw in block.split("\n"):
        line = raw.rstrip()
        s = line.strip()
        if s.startswith("/*"):
            # top border: /****...  →  #****...
            result.append(prefix + s[2:])
        elif s == "*/":
            # bottom border
            result.append(prefix + "*" * 79)
        elif s.startswith("*"):
            body = s[1:]  # drop the leading *
            result.append(prefix + (" " + body if body else ""))
        else:
            result.append(prefix + (" " + s if s else ""))
    return "\n".join(result)


def to_html_style(block: str) -> str:
    """Wrap the /* */ block in an HTML comment."""
    return "<!--\n" + block + "\n-->"


def header_for(style: str, block: str) -> str:
    """Build the header text for a comment style."""
    kind = COMMENT_STYLES[style]
    if kind == "/*":
        return block + "\n\n"
    if kind == "html":
        return to_html_style(block) + "\n\n"
    if kind == "--":
        return to_line_style(block, "--") + "\n\n"
    return to_line_style(block, "#") + "\n\n"


def file_matches_style(filepath: Path) -> str | None:
    """Return the comment style key if this file should get a header, else None."""
    name = filepath.name
    ext = filepath.suffix

    # Check exact filename matches
    if name in COMMENT_STYLES:
        return name

    # Check Dockerfile.*, Makefile.* patterns
    if name.startswith("Dockerfile") and "Dockerfile" in COMMENT_STYLES:
        return "Dockerfile"
    if name.startswith("Makefile") and "Makefile" in COMMENT_STYLES:
        return "Makefile"

    # Check extension
    if ext in COMMENT_STYLES:
        return ext

    return None


def should_exclude(filepath: Path, rel_path: str) -> bool:
    """Check if a file should be excluded."""
    # Check directory exclusions
    for part in filepath.parts:
        if part in EXCLUDE_DIRS:
            return True
        # Check nested protoc3/include
        if "protoc3" in str(filepath) and "include" in str(filepath):
            return True

    # Check file pattern exclusions
    for pattern in EXCLUDE_FILE_PATTERNS:
        if pattern.search(rel_path):
            return True

    return False


def find_source_files() -> list[Path]:
    """Find all source files that need headers."""
    files = []
    for root, dirs, filenames in os.walk(REPO_ROOT):
        root_path = Path(root)
        # Prune excluded dirs
        dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]

        for filename in filenames:
            filepath = root_path / filename
            rel_path = str(filepath.relative_to(REPO_ROOT))

            if should_exclude(filepath, rel_path):
                continue

            style = file_matches_style(filepath)
            if style is not None:
                files.append(filepath)

    return sorted(files)


def header_entity(text: str) -> str | None:
    """Return the 'information belonging exclusively to <entity>' value."""
    match = ENTITY_PATTERN.search(text)
    return match.group(1).strip() if match else None


def header_window(body: str) -> str:
    """The leading lines of a file that may contain the header block."""
    return "\n".join(body.split("\n")[:HEADER_SCAN_LINES])


def names_current_entity(text: str, entity: str) -> bool:
    """True if `text` carries a copyright notice naming `entity`.

    Matches non-canonical notices too, so a file that states the right entity
    in some other shape is recognised as compliant rather than re-headered.
    """
    return re.search(rf"Copyright \(c\) \d{{4}} {re.escape(entity)}", text) is not None


def replace_entity_in_header(body: str, old: str, new: str) -> str:
    """Swap the ownership entity on its own header line, header window only."""
    lines = body.split("\n")
    for i in range(min(len(lines), HEADER_SCAN_LINES)):
        if old in lines[i]:
            lines[i] = lines[i].replace(old, new)
            return "\n".join(lines)
    raise ValueError(f"ownership entity {old!r} not found in the header window")


def header_state(filepath: Path, style: str, header_block: str) -> tuple[str, str | None]:
    """Classify a file's header.

    Returns (state, existing_entity), where state is one of:
      "ok"        - a header is present and matches the current template
      "refreshed" - a header is present but names a different legal entity
      "added"     - there is no header at all
    """
    expected = header_for(style, header_block).rstrip("\n")
    expected_entity = header_entity(header_block)

    try:
        with open(filepath, "r") as f:
            content = f.read()
    except Exception:
        return "ok", None

    body = content
    if content.startswith("#!"):
        body = content[content.index("\n") + 1:]

    if body.lstrip("\n").startswith(expected):
        return "ok", expected_entity

    window = header_window(body)

    # The ownership line is authoritative: if it names another entity, correct
    # it even though the copyright line above may already read correctly.
    existing = header_entity(window)
    if existing is not None:
        if expected_entity is None or existing == expected_entity:
            return "ok", existing
        return "refreshed", existing

    # No ownership line, but a notice naming the current entity: compliant in a
    # different shape. Leave it -- prepending would stack a second header and
    # rewriting the leading block would delete the file's own documentation.
    if expected_entity and names_current_entity(window, expected_entity):
        return "ok", existing

    return "added", None


def process_file(filepath: Path, header_block: str, dry_run: bool = False) -> str:
    """Add or refresh one file's header. Returns the action taken."""
    style = file_matches_style(filepath)
    if style is None:
        return "skipped"

    action, existing = header_state(filepath, style, header_block)
    if action == "ok":
        return "ok"

    rel = filepath.relative_to(REPO_ROOT)
    if dry_run:
        verb = "add header to" if action == "added" else f"refresh entity {existing!r} in"
        print(f"  Would {verb}: {rel}")
        return action

    with open(filepath, "r") as f:
        content = f.read()

    if action == "added":
        header = header_for(style, header_block)
        # Handle shebang lines (keep them first)
        if content.startswith("#!"):
            newline_idx = content.index("\n")
            new_content = content[:newline_idx+1] + "\n" + header + content[newline_idx+1:]
        else:
            new_content = header + content
    else:
        # Refresh in place: the block, its placement and its comment style are
        # all already correct -- only the legal entity is stale. Prepending here
        # would leave the wrong entity in the file and stack a second header.
        expected_entity = header_entity(header_block)
        if expected_entity is None:
            raise ValueError("copyright.md has no 'belonging exclusively to' line")
        new_content = replace_entity_in_header(content, existing, expected_entity)

    with open(filepath, "w") as f:
        f.write(new_content)

    return action


def main():
    parser = argparse.ArgumentParser(description="Add copyright header to source files")
    parser.add_argument("--dry-run", action="store_true", help="Preview changes only")
    parser.add_argument("--check", action="store_true", help="Exit 1 if any file is missing header")
    args = parser.parse_args()

    header_block = load_header_text().strip()
    if not header_block:
        print("ERROR: copyright.md is empty or not found")
        sys.exit(1)

    # Strip the outer ``` markers if present (markdown code fence)
    if header_block.startswith("```"):
        header_block = "\n".join(header_block.split("\n")[1:-1]).strip()

    print(f"Using header from: {HEADER_FILE}")
    print(f"Header length: {len(header_block)} chars\n")

    files = find_source_files()
    print(f"Found {len(files)} source files to process\n")

    added = refreshed = correct = 0

    for filepath in files:
        action = process_file(filepath, header_block, dry_run=args.dry_run)
        if action == "added":
            added += 1
        elif action == "refreshed":
            refreshed += 1
        else:
            correct += 1

    changed = added + refreshed

    if args.dry_run:
        print(
            f"\nDry-run complete. Would add: {added}, "
            f"would refresh: {refreshed}, already correct: {correct}"
        )
    elif args.check:
        print(
            f"\nCheck complete. Missing header: {added}, "
            f"stale entity: {refreshed}, correct: {correct}"
        )
        if changed > 0:
            sys.exit(1)
    else:
        print(f"\nDone! Added: {added}, refreshed: {refreshed}, already correct: {correct}")


if __name__ == "__main__":
    main()
