#!/usr/bin/env python3
"""Capture one declarative binary demo at an exact isolated artifact cut."""

from __future__ import annotations

import argparse
import base64
import fcntl
import hashlib
import json
import os
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time
from pathlib import Path
from typing import Any

DIGEST = re.compile(r"^(?:sha256:)?([0-9a-f]{64})$")
SHA = re.compile(r"^[0-9a-f]{40}$")
REPOSITORY = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
ARTIFACT_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$")
SAFE_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
SAFE_MARKER = re.compile(r"^[a-z0-9][a-z0-9._:-]{0,79}$")
NON_AUTHORITIES = [
    "first-party-identity", "system-identity", "kfd-compliance",
    "product-system-metadata", "package-metadata", "registry-history",
    "scan-output", "standalone-generation",
]
RENDITIONS = [
    {"id": "1080p", "role": "primary", "columns": 150, "rows": 36, "width": 1920, "height": 1080},
    {"id": "720p", "role": "responsive", "columns": 100, "rows": 28, "width": 1280, "height": 720},
]
STANDARD_MAX_SECONDS = 60
LONG_FORM_MAX_SECONDS = 180
MAX_EXECUTABLE_FILES = 32
MAX_CAPTURE_EVENTS = 10_000


class CaptureError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise CaptureError(message)


def stable_json(value: Any) -> str:
    def ordered(item: Any) -> Any:
        if isinstance(item, dict):
            return {key: ordered(item[key]) for key in sorted(item)}
        if isinstance(item, list):
            return [ordered(entry) for entry in item]
        return item
    return json.dumps(ordered(value), indent=2, ensure_ascii=False) + "\n"


def root_bytes(value: bytes) -> str:
    return f"sha256:{hashlib.sha256(value).hexdigest()}"


def root_json(value: Any) -> str:
    return root_bytes(stable_json(value).encode("utf-8"))


def read_object(file: Path, label: str) -> dict[str, Any]:
    require(file.is_file() and not file.is_symlink() and file.stat().st_size <= 8 * 1024 * 1024,
            f"{label} must be a bounded regular JSON file")
    try:
        value = json.loads(file.read_text(encoding="utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise CaptureError(f"{label} is invalid: {error}") from error
    require(isinstance(value, dict), f"{label} must contain an object")
    return value


def inside(root: Path, relative: str, label: str) -> Path:
    require(isinstance(relative, str) and relative and not os.path.isabs(relative), f"{label} must be relative")
    resolved = (root / relative).resolve()
    require(resolved != root and resolved.is_relative_to(root), f"{label} escapes its root")
    return resolved


def clean_environment(home: Path, declared: dict[str, str]) -> dict[str, str]:
    base = {
        "PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(home),
        "XDG_CACHE_HOME": str(home / ".cache"), "XDG_CONFIG_HOME": str(home / ".config"),
        "XDG_DATA_HOME": str(home / ".local/share"), "XDG_STATE_HOME": str(home / ".local/state"),
        "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "TZ": "UTC", "CI": "true",
        "TERM": "xterm-256color", "COLORTERM": "truecolor", "FORCE_COLOR": "3",
    }
    for key, value in declared.items():
        require(re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", key) is not None, f"environment key is invalid: {key}")
        require(isinstance(value, str) and len(value) <= 256, f"environment value is invalid: {key}")
        require(key not in base, f"environment may not override the isolated baseline: {key}")
        base[key] = value
    return base


def run_pty(argv: list[str], cwd: Path, env: dict[str, str], columns: int, rows: int,
            timeout_seconds: float) -> tuple[bytes, int, int, list[tuple[int, bytes]]]:
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
    started = time.monotonic()
    process = subprocess.Popen(argv, cwd=cwd, env=env, stdin=slave, stdout=slave, stderr=slave,
                               start_new_session=True, close_fds=True)
    os.close(slave)
    chunks: list[bytes] = []
    timed_chunks: list[tuple[int, bytes]] = []
    total = 0
    deadline = started + timeout_seconds
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=5)
                raise CaptureError(f"step exceeded its {timeout_seconds}-second bound")
            readable, _, _ = select.select([master], [], [], min(remaining, 0.1))
            eof = False
            if readable:
                try:
                    chunk = os.read(master, 65536)
                except OSError as error:
                    if error.errno == 5:
                        chunk = b""
                    else:
                        raise
                if chunk:
                    total += len(chunk)
                    require(total <= 4 * 1024 * 1024, "step output exceeds 4 MiB")
                    chunks.append(chunk)
                    timed_chunks.append((max(0, int((time.monotonic() - started) * 1000)), chunk))
                else:
                    eof = True
            if process.poll() is not None and (not readable or eof):
                break
    finally:
        os.close(master)
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)
    elapsed = max(1, int((time.monotonic() - started) * 1000))
    return b"".join(chunks), int(process.returncode or 0), elapsed, timed_chunks


def safe_terminal_text(raw: bytes, replacements: dict[str, str]) -> str:
    require(b"\0" not in raw, "terminal output contains NUL")
    text = raw.decode("utf-8", errors="strict")
    for source, target in sorted(replacements.items(), key=lambda entry: -len(entry[0])):
        text = text.replace(source, target)
    forbidden = [
        r"/home/runner/", r"/Users/[^/\s]+/", r"(?i)(token|password|secret|cookie)\s*=",
        r"\bgh[pousr]_[A-Za-z0-9]{20,}\b", r"\bgithub_pat_[A-Za-z0-9_]{20,}\b",
    ]
    for pattern in forbidden:
        require(re.search(pattern, text) is None, "terminal output contains a private path or credential-shaped value")
    return text


def safe_text(raw: bytes, replacements: dict[str, str]) -> str:
    return safe_terminal_text(raw, replacements).replace("\r\n", "\n").replace("\r", "\n")


def timed_public_chunks(raw: bytes, timed_chunks: list[tuple[int, bytes]],
                        replacements: dict[str, str]) -> tuple[bytes, list[tuple[int, bytes]]]:
    public = safe_terminal_text(raw, replacements).encode("utf-8")
    if not raw:
        return public, []
    mapped: list[tuple[int, bytes]] = []
    raw_end = 0
    public_start = 0
    for index, (at_ms, chunk) in enumerate(timed_chunks):
        raw_end += len(chunk)
        public_end = len(public) if index == len(timed_chunks) - 1 else round(len(public) * raw_end / len(raw))
        if public_end > public_start:
            mapped.append((at_ms, public[public_start:public_end]))
            public_start = public_end
    require(public_start == len(public), "sanitized terminal timing projection is incomplete")
    return public, mapped


def dotted(value: Any, expression: str) -> Any:
    current = value
    for part in expression.split("."):
        require(isinstance(current, dict) and part in current, f"JSON assertion path is absent: {expression}")
        current = current[part]
    return current


def assert_files(workspace: Path, assertions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    evidence = []
    for assertion in assertions:
        target = inside(workspace, assertion.get("path"), "file assertion path")
        value = read_object(target, f"assertion file {assertion.get('path')}")
        for expression, expected in assertion.get("jsonEquals", {}).items():
            require(dotted(value, expression) == expected, f"JSON assertion failed: {assertion.get('path')}#{expression}")
        evidence.append({"path": assertion["path"], "root": root_json(value)})
    return evidence


def validate_scenario(value: dict[str, Any]) -> dict[str, Any]:
    require(value.get("schema") == "buildchain.declarative-binary-demo/v1", "scenario schema mismatch")
    require(value.get("renditions") == RENDITIONS, "scenario must declare the two native rendition profiles exactly")
    product = value.get("product") or {}
    require(SAFE_ID.fullmatch(str(product.get("id") or "")) is not None, "product id is invalid")
    require(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", str(product.get("binaryName") or "")) is not None,
            "product binaryName is invalid")
    execution = value.get("execution") or {}
    require(execution.get("deterministic") is True and execution.get("network") == "none" and execution.get("secrets") == "none",
            "scenario execution boundary must be deterministic, secret-free, and network-disabled")
    duration_class = execution.get("durationClass", "standard")
    require(duration_class in ("standard", "long-form"), "scenario duration class is invalid")
    maximum_seconds = LONG_FORM_MAX_SECONDS if duration_class == "long-form" else STANDARD_MAX_SECONDS
    require(isinstance(execution.get("totalTimeoutSeconds"), int) and 1 <= execution["totalTimeoutSeconds"] <= maximum_seconds,
            "scenario total timeout is invalid")
    require(isinstance(execution.get("environment"), dict), "scenario environment must be an object")
    transport_smoke = value.get("transportSmoke")
    if transport_smoke is not None:
        require(isinstance(transport_smoke, dict) and set(transport_smoke) == {
            "argv", "timeoutSeconds", "expectedExitCodes", "stdoutIncludes"
        }, "scenario transport smoke shape is invalid")
        require(isinstance(transport_smoke.get("argv"), list) and 1 <= len(transport_smoke["argv"]) <= 64,
                "scenario transport smoke argv is invalid")
        require(all(isinstance(item, str) and "\0" not in item and len(item) <= 512 for item in transport_smoke["argv"]),
                "scenario transport smoke argv is invalid")
        require(isinstance(transport_smoke.get("timeoutSeconds"), int) and 1 <= transport_smoke["timeoutSeconds"] <= 60,
                "scenario transport smoke timeout is invalid")
        require(isinstance(transport_smoke.get("expectedExitCodes"), list) and 1 <= len(transport_smoke["expectedExitCodes"]) <= 4,
                "scenario transport smoke expected exits are invalid")
        require(all(isinstance(item, int) and 0 <= item <= 255 for item in transport_smoke["expectedExitCodes"]),
                "scenario transport smoke expected exits are invalid")
        require(isinstance(transport_smoke.get("stdoutIncludes"), list) and len(transport_smoke["stdoutIncludes"]) <= 32,
                "scenario transport smoke stdout assertions are invalid")
        require(all(isinstance(item, str) and 1 <= len(item) <= 256 for item in transport_smoke["stdoutIncludes"]),
                "scenario transport smoke stdout assertions are invalid")
    demos = value.get("demos")
    require(isinstance(demos, list) and 1 <= len(demos) <= 8, "scenario requires 1 through 8 demos")
    ids = [entry.get("id") for entry in demos]
    require(all(SAFE_ID.fullmatch(str(entry or "")) for entry in ids) and len(ids) == len(set(ids)), "demo ids are invalid or repeated")
    for demo in demos:
        steps = demo.get("steps")
        require(isinstance(steps, list) and 1 <= len(steps) <= 12, f"demo {demo['id']} requires bounded steps")
        step_ids = [entry.get("id") for entry in steps]
        require(all(SAFE_ID.fullmatch(str(entry or "")) for entry in step_ids) and len(step_ids) == len(set(step_ids)),
                f"demo {demo['id']} step ids are invalid or repeated")
        for step in steps:
            require("command" not in step and isinstance(step.get("argv"), list) and step["argv"],
                    f"demo {demo['id']} step {step['id']} must use literal argv")
            require(all(isinstance(item, str) and "\0" not in item and len(item) <= 512 for item in step["argv"]),
                    f"demo {demo['id']} step {step['id']} argv is invalid")
            require(isinstance(step.get("timeoutSeconds"), int) and 1 <= step["timeoutSeconds"] <= maximum_seconds,
                    f"demo {demo['id']} step {step['id']} timeout is invalid")
            require(isinstance(step.get("expectedExitCodes"), list) and step["expectedExitCodes"],
                    f"demo {demo['id']} step {step['id']} expected exits are invalid")
            require(isinstance(step.get("stdoutIncludes"), list) and isinstance(step.get("fileAssertions"), list),
                    f"demo {demo['id']} step {step['id']} assertions are invalid")
    presentation = value.get("presentation")
    if presentation is not None:
        require(isinstance(presentation, dict) and set(presentation) == {"schema", "proofs", "materialization"},
                "scenario presentation shape is invalid")
        require(presentation.get("schema") == "buildchain.declarative-demo-presentation/v1",
                "scenario presentation schema is unsupported")
        proofs = presentation.get("proofs")
        require(isinstance(proofs, list) and len(proofs) == len(demos),
                "scenario presentation must bind every demo exactly once")
        labels: set[str] = set()
        for index, proof in enumerate(proofs):
            required = {"demoId", "label", "question", "summary"}
            require(isinstance(proof, dict) and required <= set(proof) <= required | {"transitionAfter"},
                    f"scenario presentation proof {index} shape is invalid")
            require(proof.get("demoId") == demos[index].get("id"),
                    f"scenario presentation proof {index} must preserve demo order")
            label = proof.get("label")
            require(isinstance(label, str) and 1 <= len(label) <= 80 and label not in labels,
                    f"scenario presentation proof {index} label is invalid or repeated")
            labels.add(label)
            question = proof.get("question")
            require(isinstance(question, str) and 1 <= len(question) <= 120 and question == demos[index].get("title"),
                    f"scenario presentation proof {index} question must equal the demo title")
            require(isinstance(proof.get("summary"), str) and 1 <= len(proof["summary"]) <= 500,
                    f"scenario presentation proof {index} summary is invalid")
            transition = proof.get("transitionAfter")
            require(transition is None or isinstance(transition, str) and 1 <= len(transition) <= 500,
                    f"scenario presentation proof {index} transition is invalid")
        materialization = presentation.get("materialization")
        require(isinstance(materialization, dict) and set(materialization) == {
            "readmeMode", "technicalSpecPath", "technicalSpecTitle", "technicalMarker"
        }, "scenario presentation materialization shape is invalid")
        require(materialization.get("readmeMode") in ("full", "media-only"),
                "scenario presentation README mode is invalid")
        technical_path = inside(Path("/repository"), materialization.get("technicalSpecPath"),
                                "scenario presentation technical specification path")
        readme_path = inside(Path("/repository"), (value.get("publication") or {}).get("readmePath"),
                             "scenario publication README path")
        require(technical_path != readme_path, "scenario presentation technical specification must be separate from README")
        title = materialization.get("technicalSpecTitle")
        require(isinstance(title, str) and 1 <= len(title) <= 120,
                "scenario presentation technical specification title is invalid")
        require(SAFE_MARKER.fullmatch(str(materialization.get("technicalMarker") or "")) is not None,
                "scenario presentation technical marker is invalid")
    authority = value.get("authority") or {}
    require(authority.get("grants") == [] and authority.get("nonAuthorities") == NON_AUTHORITIES,
            "scenario authority boundary is invalid")
    return value


def validate_binary(root: Path, scenario: dict[str, Any]) -> tuple[Path, dict[str, Any], str]:
    artifact = scenario.get("artifact") or {}
    binary = inside(root, artifact.get("binaryPath"), "binaryPath")
    metadata_path = inside(root, artifact.get("metadataPath"), "metadataPath")
    metadata = read_object(metadata_path, "binary metadata")
    require(metadata.get("contract") == artifact.get("metadataContract"), "binary metadata contract mismatch")
    require((metadata.get("platformId") or metadata.get("platform")) == artifact.get("platformId"),
            "binary metadata platform mismatch")
    require(metadata.get("runtimeDependencies") == artifact.get("runtimeDependencies") == [], "binary must be standalone")
    executable_files = metadata.get("executableFiles")
    require(isinstance(executable_files, list) and 1 <= len(executable_files) <= MAX_EXECUTABLE_FILES,
            "binary metadata executableFiles must be a bounded non-empty array")
    declared: set[str] = set()
    declared_digests: dict[str, str] = {}
    for index, entry in enumerate(executable_files):
        label = f"binary metadata executableFiles[{index}]"
        require(isinstance(entry, dict) and set(entry) == {"path", "sha256"}, f"{label} must contain only path and sha256")
        relative = entry.get("path")
        require(isinstance(relative, str) and relative not in declared, f"{label}.path is invalid or repeated")
        declared.add(relative)
        executable = inside(root, relative, f"{label}.path")
        require(executable.is_file() and not executable.is_symlink() and os.access(executable, os.X_OK),
                f"{label} must be a regular executable")
        expected = entry.get("sha256")
        require(DIGEST.fullmatch(str(expected or "")) is not None, f"{label}.sha256 is invalid")
        observed_executable = hashlib.sha256(executable.read_bytes()).hexdigest()
        require(expected == observed_executable, f"{label} digest differs from exact artifact metadata")
        declared_digests[relative] = expected
    require(artifact.get("binaryPath") in declared, "binary metadata executableFiles must include binaryPath")
    observed = hashlib.sha256(binary.read_bytes()).hexdigest()
    match = DIGEST.fullmatch(str(metadata.get("sha256") or ""))
    require(match is not None and match.group(1) == observed == declared_digests[artifact["binaryPath"]],
            "binary digest differs from exact artifact metadata")
    return binary, metadata, f"sha256:{observed}"


def validate_coordinate(value: dict[str, Any]) -> dict[str, Any]:
    require(value.get("schema") == "buildchain.github-artifact-coordinate/v1", "source coordinate schema mismatch")
    require(REPOSITORY.fullmatch(str(value.get("repository") or "")) is not None, "source repository coordinate is invalid")
    require(str(value.get("runId") or "").isdigit() and str(value.get("runAttempt") or "").isdigit(),
            "source workflow run coordinate is invalid")
    require(SHA.fullmatch(str(value.get("sourceSha") or "")) is not None, "source SHA coordinate is invalid")
    require(str(value.get("id") or "").isdigit() and value.get("nodeId"), "source artifact identity is invalid")
    require(ARTIFACT_NAME.fullmatch(str(value.get("name") or "")) is not None, "source artifact name is invalid")
    require(re.fullmatch(r"sha256:[0-9a-f]{64}", str(value.get("digest") or "")) is not None,
            "source artifact digest is invalid")
    require(isinstance(value.get("sizeInBytes"), int) and value["sizeInBytes"] >= 0,
            "source artifact size is invalid")
    require(all(isinstance(value.get(key), str) and value[key] for key in ("createdAt", "expiresAt")),
            "source artifact timestamps are invalid")
    return value


def capture_rendition(binary: Path, demo: dict[str, Any], rendition: dict[str, Any], scenario: dict[str, Any], output: Path) -> dict[str, Any]:
    directory = output / "renditions" / rendition["id"]
    directory.mkdir(parents=True)
    workspace = directory / "workspace"
    workspace.mkdir()
    events: list[dict[str, Any]] = []
    transcript: list[str] = []
    summaries = []
    duration_class = scenario["execution"].get("durationClass", "standard")
    duration_limit_ms = (LONG_FORM_MAX_SECONDS if duration_class == "long-form" else STANDARD_MAX_SECONDS) * 1000
    with tempfile.TemporaryDirectory(prefix=f"buildchain-demo-{demo['id']}-{rendition['id']}-") as home_value:
        home = Path(home_value)
        env = clean_environment(home, scenario["execution"]["environment"])
        started = time.monotonic()
        deadline = started + scenario["execution"]["totalTimeoutSeconds"]
        for step in demo["steps"]:
            remaining = deadline - time.monotonic()
            require(remaining > 0, "demo exceeded its total timeout")
            display = f"{scenario['product']['binaryName']} {' '.join(step['argv'])}".rstrip()
            prompt = f"\x1b[1;38;5;81m$\x1b[0m \x1b[1m{display}\x1b[0m\r\n"
            prompt_at_ms = 0 if not events else max(events[-1]["atMs"], int((time.monotonic() - started) * 1000))
            events.append({"atMs": prompt_at_ms, "data": base64.b64encode(prompt.encode()).decode()})
            transcript.append(f"$ {display}")
            step_started_ms = int((time.monotonic() - started) * 1000)
            effective_timeout = min(float(step["timeoutSeconds"]), remaining)
            raw, exit_code, elapsed, raw_chunks = run_pty(
                [str(binary), *step["argv"]], workspace, env,
                rendition["columns"], rendition["rows"], effective_timeout,
            )
            replacements = {
                str(workspace): ".", str(binary): scenario["product"]["binaryName"],
                str(home): "<isolated-home>",
            }
            public_bytes, public_chunks = timed_public_chunks(raw, raw_chunks, replacements)
            text = safe_text(raw, replacements)
            require(exit_code in step["expectedExitCodes"], f"step {step['id']} exited with {exit_code}")
            for expected in step["stdoutIncludes"]:
                require(expected in text, f"step {step['id']} output is missing: {expected}")
            file_evidence = assert_files(workspace, step["fileAssertions"])
            for relative_at_ms, chunk in public_chunks:
                at_ms = step_started_ms + relative_at_ms
                require(at_ms < duration_limit_ms, "terminal event exceeds the declared duration class")
                events.append({"atMs": at_ms, "data": base64.b64encode(chunk).decode()})
            require(len(events) <= MAX_CAPTURE_EVENTS, "terminal capture exceeds 10000 events")
            for line in text.splitlines():
                if line:
                    transcript.append(line)
            summary = {"id": step["id"], "argv": step["argv"], "exitCode": exit_code,
                       "elapsedMs": elapsed, "outputRoot": root_bytes(public_bytes),
                       "outputEncoding": "utf-8-sanitized-terminal/v1", "fileAssertions": file_evidence}
            summaries.append({**summary, "root": root_json(summary)})
    last_event_ms = events[-1]["atMs"]
    duration = max(900, min(duration_limit_ms, last_event_ms + 600))
    require(last_event_ms < duration, "terminal event timeline does not fit the declared duration class")
    completion = {"schema": "buildchain.declarative-demo-completion/v1", "status": "qualified",
                  "demoId": demo["id"], "steps": summaries}
    completion_root = root_json(completion)
    capture = {
        "schema": "buildchain.declarative-terminal-capture/v1",
        "command": f"{scenario['product']['binaryName']} ({len(demo['steps'])} declared steps)",
        "dimensions": {"columns": rendition["columns"], "rows": rendition["rows"]},
        "durationMs": duration, "encoding": "base64", "events": events,
        "completion": {"schema": completion["schema"], "status": "qualified", "reportRoot": completion_root, "eventCount": len(events)},
        "exitCode": 0,
        "authority": {"classification": "volatile-terminal-observation", "grants": [], "nonAuthorities": NON_AUTHORITIES},
    }
    (directory / "complete-transcript.txt").write_text("\n".join(transcript) + "\n", encoding="utf-8")
    (directory / "run-summary.json").write_text(stable_json(completion), encoding="utf-8")
    (directory / "terminal-capture.json").write_text(stable_json(capture), encoding="utf-8")
    shutil.rmtree(workspace)
    return {"id": rendition["id"], "role": rendition["role"], "columns": rendition["columns"], "rows": rendition["rows"],
            "width": rendition["width"], "height": rendition["height"],
            "transcript": f"renditions/{rendition['id']}/complete-transcript.txt",
            "runSummary": f"renditions/{rendition['id']}/run-summary.json", "runSummaryRoot": completion_root,
            "terminalCapture": f"renditions/{rendition['id']}/terminal-capture.json", "terminalCaptureRoot": root_json(capture)}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact-root", required=True)
    parser.add_argument("--scenario", required=True)
    parser.add_argument("--source-coordinate", required=True)
    parser.add_argument("--demo-id", required=True)
    parser.add_argument("--network-isolation", choices=("docker-none", "test-only"), required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    artifact_root = Path(args.artifact_root).resolve()
    output = Path(args.output).resolve()
    require(artifact_root.is_dir() and not artifact_root.is_symlink(), "artifact root is invalid")
    require(not output.exists(), "capture output must be new")
    scenario = validate_scenario(read_object(Path(args.scenario).resolve(), "scenario"))
    require(args.network_isolation == "docker-none" or os.environ.get("BUILDCHAIN_AUDITABLE_DEMO_TEST") == "1",
            "production capture requires a network-disabled container controller")
    coordinate = validate_coordinate(read_object(Path(args.source_coordinate).resolve(), "source coordinate"))
    binary, metadata, binary_root = validate_binary(artifact_root, scenario)
    demo = next((entry for entry in scenario["demos"] if entry["id"] == args.demo_id), None)
    require(demo is not None, f"unknown demo id: {args.demo_id}")
    output.mkdir(parents=True)
    renditions = [capture_rendition(binary, demo, rendition, scenario, output) for rendition in RENDITIONS]
    require(renditions[0]["terminalCaptureRoot"] != renditions[1]["terminalCaptureRoot"], "native capture roots must differ")
    scenario_root = root_json(scenario)
    manifest = {
        "schema": "buildchain.declarative-demo-capture/v1", "status": "qualified",
        "demo": {"id": demo["id"], "title": demo["title"], "claimBoundary": demo["claimBoundary"]},
        "execution": {"durationClass": scenario["execution"].get("durationClass", "standard")},
        "product": {**scenario["product"], "distribution": "standalone-binary"},
        "artifact": {"platformId": scenario["artifact"]["platformId"], "binaryRoot": binary_root,
                     "metadataContract": metadata["contract"], "metadataRoot": root_json(metadata), "runtimeDependencies": []},
        "scenarioRoot": scenario_root, "sourceCoordinateRoot": root_json(coordinate), "networkIsolation": args.network_isolation,
        "renditions": renditions,
        "authority": {"classification": "capture-source-evidence", "grants": [], "nonAuthorities": NON_AUTHORITIES},
    }
    manifest["root"] = root_json(manifest)
    (output / "manifest.json").write_text(stable_json(manifest), encoding="utf-8")
    (output / "scenario.json").write_text(stable_json(scenario), encoding="utf-8")
    (output / "source-coordinate.json").write_text(stable_json(coordinate), encoding="utf-8")
    print(stable_json({"ok": True, "demoId": demo["id"], "captureRoot": manifest["root"], "output": str(output)}), end="")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (CaptureError, OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        print(f"auditable-demo-capture: {error}", file=os.sys.stderr)
        raise SystemExit(1) from error
