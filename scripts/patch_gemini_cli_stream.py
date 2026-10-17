"""Make the official Gemini CLI stream its thinking in non-interactive `stream-json` mode.

Stock `@google/gemini-cli` drops `GeminiEventType.Thought` events when run headless, so the copilot chat
has no live "thinking" feedback. This script instruments the installed bundle's `runNonInteractive2`
(the classic turn loop) and `runNonInteractive` (the ADK session loop) to emit `type: "thought"` events
to the stream formatter, and to report a context-window overflow instead of ending silently.
Networking, sign-in and model routing are left untouched.

The patch is idempotent: rerun it after every `npm install -g @google/gemini-cli@latest`.

Usage: python scripts/patch_gemini_cli_stream.py [--bundle DIR] [--check]
"""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
from pathlib import Path

MARKER = "/* copilot-thought-stream */"

# runNonInteractive2: the top of the responseStream loop, right after the cancellation check.
CLASSIC_LOOP = re.compile(
    r"(?P<indent>[ \t]*)for await \(const event of responseStream\) \{\n"
    r"(?P<inner>[ \t]*)if \(abortController\.signal\.aborted\) \{\n"
    r"[ \t]*handleCancellationError\(config\);\n"
    r"[ \t]*\}\n"
)

# runNonInteractive2: the LoopDetected branch, which the overflow branch is put in front of. Some builds
# inline the enums as string literals (`"loop_detected" /* LoopDetected */`).
CLASSIC_LOOP_DETECTED = re.compile(
    r"\} else if \(event\.type === "
    r"(?:GeminiEventType\.LoopDetected|\"loop_detected\" /\* LoopDetected \*/)\) \{"
)

# The enum references the injected code uses, as named members or as inlined literals.
NAMED_ENUMS = {
    "THOUGHT": "GeminiEventType.Thought",
    "OVERFLOW": "GeminiEventType.ContextWindowWillOverflow",
    "ERROR": "JsonStreamEventType.ERROR",
}
INLINED_ENUMS = {
    "THOUGHT": '"thought" /* Thought */',
    "OVERFLOW": '"context_window_will_overflow" /* ContextWindowWillOverflow */',
    "ERROR": '"error" /* ERROR */',
}

# runNonInteractive: the text branch of an agent message's parts.
ADK_TEXT_PART = re.compile(
    r"(?P<indent>[ \t]*)for \(const part of event\.content\) \{\n"
    r"(?P<inner>[ \t]*)if \(part\.type === \"text\"\) \{\n"
)


def _indent(block: str, prefix: str) -> str:
    return "".join(prefix + line if line.strip() else line for line in block.splitlines(keepends=True))


def _fill(template: str, enums: dict[str, str]) -> str:
    for key, value in enums.items():
        template = template.replace(f"${key}", value)
    return template


THOUGHT_EMIT = """if (event.type === $THOUGHT && streamFormatter) {
  streamFormatter.emitEvent({
    type: "thought",
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    subject: event.value?.subject,
    description: event.value?.description
  });
}
"""

OVERFLOW_BRANCH = """} else if (event.type === $OVERFLOW) {
  const message = `Context window will overflow (estimated: ${event.value.estimatedRequestTokenCount} tokens, remaining: ${event.value.remainingTokenCount} tokens)`;
  if (streamFormatter) {
    streamFormatter.emitEvent({
      type: $ERROR,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      severity: "error",
      message
    });
  }
  throw new Error(message);
"""

ADK_THOUGHT_EMIT = """if (part.type === "thought" && streamFormatter) {
  streamFormatter.emitEvent({
    type: "thought",
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    subject: part.subject,
    description: part.thought
  });
} else """


def find_bundle() -> Path:
    """The installed `@google/gemini-cli/bundle` directory."""
    npm = shutil.which("npm") or shutil.which("npm.cmd")
    if not npm:
        sys.exit("npm not found on PATH")
    root = subprocess.run([npm, "root", "-g"], capture_output=True, text=True, check=True).stdout.strip()
    bundle = Path(root) / "@google" / "gemini-cli" / "bundle"
    if not bundle.is_dir():
        sys.exit(f"Gemini CLI bundle not found at {bundle}; run `npm install -g @google/gemini-cli@latest`")
    return bundle


def entry_bundles(bundle: Path) -> list[Path]:
    """The bundle files that define both non-interactive runners."""
    return [
        path
        for path in sorted(bundle.glob("*.js"))
        if "async function runNonInteractive2(" in (text := path.read_text(encoding="utf-8"))
        and "async function runNonInteractive(" in text
    ]


def _function_span(source: str, name: str) -> tuple[int, int]:
    """Where the top-level function `name` starts and where the next top-level function starts."""
    start = source.index(f"async function {name}(")
    following = re.compile(r"^(?:async )?function \w+\(", re.M)
    match = following.search(source, start + 1)
    return start, match.start() if match else len(source)


def patch_source(source: str) -> str:
    """`source` with both runners instrumented. Raises ValueError when an anchor isn't found."""
    if MARKER in source:
        return source

    # Classic runner: thought events and context overflow.
    start, end = _function_span(source, "runNonInteractive2")
    body = source[start:end]
    loop = CLASSIC_LOOP.search(body)
    if not loop:
        raise ValueError("runNonInteractive2: responseStream loop not found")
    inner = loop.group("inner")
    enums = NAMED_ENUMS if "GeminiEventType." in body else INLINED_ENUMS
    body = body[: loop.end()] + _indent(f"{MARKER}\n" + _fill(THOUGHT_EMIT, enums), inner) + body[loop.end() :]
    detected = CLASSIC_LOOP_DETECTED.search(body, loop.end())
    if not detected:
        raise ValueError("runNonInteractive2: LoopDetected branch not found")
    overflow = _indent(_fill(OVERFLOW_BRANCH, enums), inner).lstrip()
    body = body[: detected.start()] + overflow + inner + body[detected.start() :]
    source = source[:start] + body + source[end:]

    # ADK session runner: thought parts of agent messages.
    start, end = _function_span(source, "runNonInteractive")
    body = source[start:end]
    part = ADK_TEXT_PART.search(body)
    if not part:
        raise ValueError("runNonInteractive: agent message part loop not found")
    inner = part.group("inner")
    emit = _indent(f"{MARKER}\n" + ADK_THOUGHT_EMIT, inner)
    # The emit ends in "} else " so it chains onto the original `if (part.type === "text")`.
    body = body[: part.start("inner")] + emit + body[part.end("inner") :]
    return source[:start] + body + source[end:]


def node_check(path: Path) -> None:
    node = shutil.which("node")
    if not node:
        sys.exit("node not found on PATH")
    result = subprocess.run([node, "--check", str(path)], capture_output=True, text=True)
    if result.returncode != 0:
        raise ValueError(f"node --check failed for {path.name}:\n{result.stderr}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--bundle", type=Path, help="the gemini-cli bundle directory (default: from `npm root -g`)")
    parser.add_argument("--check", action="store_true", help="only report whether the bundle is patched")
    args = parser.parse_args()

    bundle = args.bundle or find_bundle()
    targets = entry_bundles(bundle)
    if not targets:
        print(f"No bundle in {bundle} defines runNonInteractive/runNonInteractive2", file=sys.stderr)
        return 1

    failed = False
    for path in targets:
        source = path.read_text(encoding="utf-8")
        if MARKER in source:
            print(f"{path.name}: already patched")
            continue
        if args.check:
            print(f"{path.name}: not patched")
            failed = True
            continue
        try:
            patched = patch_source(source)
        except ValueError as exc:
            print(f"{path.name}: {exc}", file=sys.stderr)
            failed = True
            continue
        backup = path.with_name(path.name + ".orig")
        if not backup.exists():
            backup.write_text(source, encoding="utf-8")
        path.write_text(patched, encoding="utf-8")
        try:
            node_check(path)
        except ValueError as exc:
            path.write_text(source, encoding="utf-8")
            print(f"{exc}\n{path.name}: restored the original", file=sys.stderr)
            failed = True
            continue
        print(f"{path.name}: patched (syntax OK)")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
