#!/usr/bin/env python3

#****************************************************************************
#*
#* Copyright (c) 2026 AnantHQ Inc.
#* All Rights Reserved.
#*
#* This software is licensed, not sold.
#*
#* The contents of this file constitute confidential and proprietary
#* information belonging exclusively to Unison Software Technologies Pvt. Ltd.
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
    python scripts/add_copyright.py --check      # Exit 1 if any file is missing header

The header is read from copyright.md at the repository root.
Idempotent: skips files that already contain the header.
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
]


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


def file_has_header(filepath: Path, marker: str) -> bool:
    """Check if a file already has the copyright header."""
    try:
        with open(filepath, "r") as f:
            first_lines = "".join([f.readline() for _ in range(35)])
        return "AnantHQ Inc." in first_lines and marker in first_lines
    except Exception:
        return False


def process_file(filepath: Path, header_block: str, dry_run: bool = False) -> bool:
    """Add header to a single file. Returns True if modified."""
    style = file_matches_style(filepath)

    if style is None:
        return False

    marker = "AnantHQ Inc."
    header = header_for(style, header_block)

    if file_has_header(filepath, marker):
        return False

    if dry_run:
        rel = filepath.relative_to(REPO_ROOT)
        print(f"  Would add header: {rel}")
        return True

    # Read original content
    with open(filepath, "r") as f:
        content = f.read()

    # Handle shebang lines (keep them first)
    if content.startswith("#!"):
        newline_idx = content.index("\n")
        new_content = content[:newline_idx+1] + "\n" + header + content[newline_idx+1:]
    else:
        new_content = header + content

    with open(filepath, "w") as f:
        f.write(new_content)

    return True


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

    modified = 0
    skipped = 0

    for filepath in files:
        if process_file(filepath, header_block, dry_run=args.dry_run):
            modified += 1
        else:
            skipped += 1

    if args.dry_run:
        print(f"\nDry-run complete. Would modify: {modified}, Already have header: {skipped}")
    elif args.check:
        print(f"\nCheck complete. Missing header: {modified}, Have header: {skipped}")
        if modified > 0:
            sys.exit(1)
    else:
        print(f"\nDone! Modified: {modified}, Skipped (already had header): {skipped}")


if __name__ == "__main__":
    main()
