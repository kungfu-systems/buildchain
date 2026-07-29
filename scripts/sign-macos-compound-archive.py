#!/usr/bin/env python3
"""Sign every Mach-O in a sealed archive, including code embedded in wheels."""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import tarfile
import zipfile


MACH_O_MAGICS = {
    bytes.fromhex(value)
    for value in (
        "feedface", "cefaedfe", "feedfacf", "cffaedfe",
        "cafebabe", "bebafeca", "cafebabf", "bfbafeca",
    )
}


def safe_name(value: str, label: str) -> PurePosixPath:
    if not value or "\\" in value:
        raise ValueError(f"{label} contains an unsafe archive path")
    name = PurePosixPath(value)
    if name.is_absolute() or any(part in {"", ".", ".."} for part in name.parts):
        raise ValueError(f"{label} contains an unsafe archive path")
    return name


def safe_link(name: PurePosixPath, value: str, label: str) -> None:
    target = PurePosixPath(value)
    if not value or target.is_absolute() or "\\" in value:
        raise ValueError(f"{label} contains an unsafe symbolic link")
    depth = 0
    for part in (*name.parent.parts, *target.parts):
        if part in {"", "."}:
            continue
        if part == "..":
            depth -= 1
        else:
            depth += 1
        if depth < 0:
            raise ValueError(f"{label} contains an escaping symbolic link")


def extract_tar(archive: Path, root: Path) -> None:
    with tarfile.open(archive, "r:*") as source:
        seen: set[str] = set()
        for member in source.getmembers():
            name = safe_name(member.name.rstrip("/"), "compound archive")
            key = name.as_posix().casefold()
            if key in seen:
                raise ValueError("compound archive contains colliding paths")
            seen.add(key)
            target = root.joinpath(*name.parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                target.parent.mkdir(parents=True, exist_ok=True)
                stream = source.extractfile(member)
                if stream is None:
                    raise ValueError("compound archive file body is missing")
                with target.open("wb") as output:
                    shutil.copyfileobj(stream, output)
                os.chmod(target, member.mode & 0o777)
            elif member.issym():
                safe_link(name, member.linkname, "compound archive")
                target.parent.mkdir(parents=True, exist_ok=True)
                os.symlink(member.linkname, target)
            else:
                raise ValueError("compound archive contains an unsupported entry type")


def zip_is_symlink(info: zipfile.ZipInfo) -> bool:
    return stat.S_ISLNK((info.external_attr >> 16) & 0xFFFF)


def extract_zip(archive: Path, root: Path) -> list[zipfile.ZipInfo]:
    with zipfile.ZipFile(archive) as source:
        infos = source.infolist()
        seen: set[str] = set()
        for info in infos:
            name = safe_name(info.filename.rstrip("/"), "compound archive")
            key = name.as_posix().casefold()
            if key in seen:
                raise ValueError("compound archive contains colliding paths")
            seen.add(key)
            target = root.joinpath(*name.parts)
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            body = source.read(info)
            target.parent.mkdir(parents=True, exist_ok=True)
            if zip_is_symlink(info):
                link = body.decode("utf-8")
                safe_link(name, link, "compound archive")
                os.symlink(link, target)
            else:
                target.write_bytes(body)
                mode = (info.external_attr >> 16) & 0o777
                if mode:
                    os.chmod(target, mode)
        return infos


def is_mach_o(path: Path) -> bool:
    if not path.is_file() or path.is_symlink():
        return False
    with path.open("rb") as source:
        return source.read(4) in MACH_O_MAGICS


def run_codesign(path: Path, args: argparse.Namespace) -> None:
    subprocess.run(
        [args.codesign, "--force", "--options", "runtime", "--timestamp",
         "--keychain", args.keychain, "--sign", args.identity, str(path)],
        check=True,
    )
    subprocess.run(
        [args.codesign, "--verify", "--strict", "--verbose=4", str(path)],
        check=True,
    )
    detail = subprocess.run(
        [args.codesign, "--display", "--verbose=4", str(path)],
        check=True,
        text=True,
        capture_output=True,
    )
    output = f"{detail.stdout}\n{detail.stderr}"
    if f"TeamIdentifier={args.team_id}" not in output:
        raise ValueError("signed Mach-O TeamIdentifier mismatch")
    if "Runtime Version" not in output and "runtime" not in output.lower():
        raise ValueError("signed Mach-O does not prove hardened runtime")
    if "Timestamp=" not in output:
        raise ValueError("signed Mach-O does not prove a secure timestamp")


def wheel_hash(body: bytes) -> str:
    return base64.urlsafe_b64encode(hashlib.sha256(body).digest()).rstrip(b"=").decode()


def sign_wheel(wheel: Path, work: Path, args: argparse.Namespace) -> int:
    with zipfile.ZipFile(wheel) as source:
        infos = source.infolist()
        if not infos:
            raise ValueError("embedded wheel is empty")
        bodies: dict[str, bytes] = {}
        seen: set[str] = set()
        records: list[str] = []
        for info in infos:
            name = safe_name(info.filename.rstrip("/"), "embedded wheel")
            key = name.as_posix().casefold()
            if key in seen:
                raise ValueError("embedded wheel contains colliding paths")
            seen.add(key)
            if zip_is_symlink(info):
                raise ValueError("embedded wheel must not contain symbolic links")
            if not info.is_dir():
                bodies[info.filename] = source.read(info)
                if len(name.parts) == 2 and name.parts[0].endswith(".dist-info") and name.name == "RECORD":
                    records.append(info.filename)
    if len(records) != 1:
        raise ValueError("embedded wheel must contain exactly one top-level dist-info RECORD")
    root = work / f"wheel-{hashlib.sha256(str(wheel).encode()).hexdigest()[:16]}"
    root.mkdir()
    for name, body in bodies.items():
        target = root.joinpath(*PurePosixPath(name).parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body)
    signed = 0
    for target in sorted(root.rglob("*")):
        if is_mach_o(target):
            run_codesign(target, args)
            signed += 1
    if signed == 0:
        shutil.rmtree(root)
        return 0
    for name in list(bodies):
        bodies[name] = root.joinpath(*PurePosixPath(name).parts).read_bytes()
    record = records[0]
    rows = []
    for name in sorted(bodies):
        if name == record:
            continue
        body = bodies[name]
        rows.append((name, f"sha256={wheel_hash(body)}", str(len(body))))
    rows.append((record, "", ""))
    stream = io.StringIO(newline="")
    csv.writer(stream, lineterminator="\n").writerows(rows)
    bodies[record] = stream.getvalue().encode()
    replacement = wheel.with_suffix(".signed.whl")
    with zipfile.ZipFile(replacement, "w") as output:
        for info in infos:
            if info.is_dir():
                output.writestr(info, b"")
            else:
                output.writestr(info, bodies[info.filename])
    replacement.replace(wheel)
    shutil.rmtree(root)
    return signed


def repack_tar(root: Path, archive: Path) -> None:
    replacement = archive.with_name(f"{archive.name}.signed")
    with tarfile.open(replacement, "w:gz", format=tarfile.PAX_FORMAT, dereference=False) as output:
        for child in sorted(root.iterdir(), key=lambda item: item.name):
            output.add(child, arcname=child.name, recursive=True)
    replacement.replace(archive)


def repack_zip(root: Path, archive: Path, infos: list[zipfile.ZipInfo]) -> None:
    replacement = archive.with_name(f"{archive.name}.signed")
    with zipfile.ZipFile(replacement, "w") as output:
        for info in infos:
            target = root.joinpath(*PurePosixPath(info.filename.rstrip("/")).parts)
            if info.is_dir():
                output.writestr(info, b"")
            elif zip_is_symlink(info):
                output.writestr(info, os.readlink(target).encode())
            else:
                output.writestr(info, target.read_bytes())
    replacement.replace(archive)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", required=True)
    parser.add_argument("--work-root", required=True)
    parser.add_argument("--notary-root", required=True)
    parser.add_argument("--evidence", required=True)
    parser.add_argument("--identity", required=True)
    parser.add_argument("--keychain", required=True)
    parser.add_argument("--team-id", required=True)
    parser.add_argument("--codesign", default="/usr/bin/codesign")
    args = parser.parse_args()
    archive = Path(args.archive).resolve()
    work = Path(args.work_root).resolve()
    root = Path(args.notary_root).resolve()
    work.mkdir(parents=True)
    root.mkdir(parents=True)
    if zipfile.is_zipfile(archive):
        archive_format = "zip"
        infos = extract_zip(archive, root)
    elif tarfile.is_tarfile(archive):
        archive_format = "tar.gz"
        infos = []
        extract_tar(archive, root)
    else:
        raise ValueError("compound Apple archive must be zip or tar.gz")
    wheel_count = 0
    wheel_mach_o_count = 0
    for wheel in sorted(root.rglob("*.whl")):
        wheel_count += 1
        wheel_mach_o_count += sign_wheel(wheel, work, args)
    mach_o_count = 0
    for target in sorted(root.rglob("*"), key=lambda item: (-len(item.parts), str(item))):
        if is_mach_o(target):
            run_codesign(target, args)
            mach_o_count += 1
    if mach_o_count + wheel_mach_o_count == 0:
        raise ValueError("compound Apple archive contains no Mach-O code")
    if archive_format == "zip":
        repack_zip(root, archive, infos)
    else:
        repack_tar(root, archive)
    evidence = {
        "archiveFormat": archive_format,
        "machOCount": mach_o_count,
        "wheelCount": wheel_count,
        "wheelMachOCount": wheel_mach_o_count,
        "checks": [
            "codesign-strict", "developer-id-team", "hardened-runtime",
            "secure-timestamp", "compound-archive-safe-paths",
            "embedded-wheel-record-integrity",
        ],
    }
    Path(args.evidence).write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
