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
THIN_MACH_O_ENDIAN = {
    bytes.fromhex("feedface"): "big",
    bytes.fromhex("feedfacf"): "big",
    bytes.fromhex("cefaedfe"): "little",
    bytes.fromhex("cffaedfe"): "little",
}
FAT_MACH_O_LAYOUT = {
    bytes.fromhex("cafebabe"): ("big", 20, 4),
    bytes.fromhex("bebafeca"): ("little", 20, 4),
    bytes.fromhex("cafebabf"): ("big", 32, 8),
    bytes.fromhex("bfbafeca"): ("little", 32, 8),
}
MH_EXECUTE = 2
JIT_EXECUTABLE_ENTITLEMENTS = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
</dict>
</plist>
"""


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


def thin_mach_o_filetype(source, offset: int = 0) -> int:
    source.seek(offset)
    header = source.read(16)
    if len(header) != 16 or header[:4] not in THIN_MACH_O_ENDIAN:
        raise ValueError("Mach-O payload has an invalid thin header")
    return int.from_bytes(header[12:16], THIN_MACH_O_ENDIAN[header[:4]])


def mach_o_filetypes(path: Path) -> set[int]:
    with path.open("rb") as source:
        magic = source.read(4)
        if magic in THIN_MACH_O_ENDIAN:
            return {thin_mach_o_filetype(source)}
        byteorder, entry_size, offset_size = FAT_MACH_O_LAYOUT[magic]
        count_body = source.read(4)
        if len(count_body) != 4:
            raise ValueError("Mach-O payload has an invalid fat header")
        count = int.from_bytes(count_body, byteorder)
        if count < 1 or count > 64:
            raise ValueError("Mach-O payload has an invalid architecture count")
        offsets = []
        for _ in range(count):
            entry = source.read(entry_size)
            if len(entry) != entry_size:
                raise ValueError("Mach-O payload has a truncated architecture table")
            offsets.append(int.from_bytes(entry[8 : 8 + offset_size], byteorder))
        return {thin_mach_o_filetype(source, offset) for offset in offsets}


def entitlement_target(path: Path, args: argparse.Namespace) -> bool:
    try:
        relative = path.relative_to(args.archive_root).as_posix()
    except ValueError:
        return False
    if relative not in args.entitlements_paths:
        return False
    if mach_o_filetypes(path) != {MH_EXECUTE}:
        raise ValueError(
            f"requested entitlement path is not a Mach-O executable: {relative}"
        )
    args.matched_entitlements_paths.add(relative)
    return True


def entitlements_path(args: argparse.Namespace) -> Path | None:
    if args.entitlements_profile == "none":
        return None
    target = Path(args.work_root) / "jit-executable-v1.plist"
    if not target.exists():
        target.write_text(JIT_EXECUTABLE_ENTITLEMENTS, encoding="utf-8")
    return target


def run_codesign(path: Path, args: argparse.Namespace) -> bool:
    signing = [args.codesign, "--force", "--options", "runtime", "--timestamp"]
    entitlements = entitlements_path(args) if entitlement_target(path, args) else None
    if entitlements is not None:
        signing.extend(["--entitlements", str(entitlements)])
    signing.extend(
        ["--keychain", args.keychain, "--sign", args.identity, str(path)]
    )
    subprocess.run(
        signing,
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
    if entitlements is not None:
        entitlement_detail = subprocess.run(
            [args.codesign, "--display", "--entitlements", ":-", str(path)],
            check=True,
            text=True,
            capture_output=True,
        )
        entitlement_output = f"{entitlement_detail.stdout}\n{entitlement_detail.stderr}"
        if "com.apple.security.cs.allow-jit" not in entitlement_output:
            raise ValueError("signed executable does not prove the requested JIT entitlement")
    return entitlements is not None


def wheel_hash(body: bytes) -> str:
    return base64.urlsafe_b64encode(hashlib.sha256(body).digest()).rstrip(b"=").decode()


def sign_wheel(wheel: Path, work: Path, args: argparse.Namespace) -> tuple[int, int]:
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
    entitled = 0
    for target in sorted(root.rglob("*")):
        if is_mach_o(target):
            entitled += int(run_codesign(target, args))
            signed += 1
    if signed == 0:
        shutil.rmtree(root)
        return 0, 0
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
    return signed, entitled


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
    parser.add_argument(
        "--entitlements-profile",
        choices=("none", "jit-executable-v1"),
        default="none",
    )
    parser.add_argument("--entitlements-paths", default="")
    parser.add_argument("--codesign", default="/usr/bin/codesign")
    args = parser.parse_args()
    archive = Path(args.archive).resolve()
    work = Path(args.work_root).resolve()
    root = Path(args.notary_root).resolve()
    args.archive_root = root
    declared_entitlements_paths = [
        safe_name(value, "entitlements path").as_posix()
        for value in args.entitlements_paths.split(",")
        if value
    ]
    if len(declared_entitlements_paths) != len(set(declared_entitlements_paths)):
        raise ValueError("entitlements paths must not contain duplicates")
    args.entitlements_paths = set(declared_entitlements_paths)
    args.matched_entitlements_paths = set()
    if (
        (args.entitlements_profile == "none" and args.entitlements_paths)
        or (args.entitlements_profile != "none" and not args.entitlements_paths)
    ):
        raise ValueError(
            "entitlements paths must be non-empty exactly when a profile is enabled"
        )
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
    entitled_executable_count = 0
    for wheel in sorted(root.rglob("*.whl")):
        wheel_count += 1
        wheel_signed, wheel_entitled = sign_wheel(wheel, work, args)
        wheel_mach_o_count += wheel_signed
        entitled_executable_count += wheel_entitled
    mach_o_count = 0
    for target in sorted(root.rglob("*"), key=lambda item: (-len(item.parts), str(item))):
        if is_mach_o(target):
            entitled_executable_count += int(run_codesign(target, args))
            mach_o_count += 1
    if mach_o_count + wheel_mach_o_count == 0:
        raise ValueError("compound Apple archive contains no Mach-O code")
    if args.entitlements_profile != "none" and entitled_executable_count == 0:
        raise ValueError(
            "requested JIT entitlement profile found no executable Mach-O payload"
        )
    unmatched = args.entitlements_paths - args.matched_entitlements_paths
    if unmatched:
        raise ValueError(
            "requested entitlement paths were not signed: " + ", ".join(sorted(unmatched))
        )
    if archive_format == "zip":
        repack_zip(root, archive, infos)
    else:
        repack_tar(root, archive)
    evidence = {
        "archiveFormat": archive_format,
        "machOCount": mach_o_count,
        "wheelCount": wheel_count,
        "wheelMachOCount": wheel_mach_o_count,
        "entitlementsProfile": args.entitlements_profile,
        "entitledExecutableCount": entitled_executable_count,
        "entitledPaths": sorted(args.matched_entitlements_paths),
        **(
            {
                "entitlementsSha256": "sha256:"
                + hashlib.sha256(JIT_EXECUTABLE_ENTITLEMENTS.encode()).hexdigest()
            }
            if args.entitlements_profile != "none"
            else {}
        ),
        "checks": [
            "codesign-strict", "developer-id-team", "hardened-runtime",
            "secure-timestamp", "compound-archive-safe-paths",
            "embedded-wheel-record-integrity",
            *(
                ["jit-executable-entitlement"]
                if args.entitlements_profile != "none"
                else []
            ),
        ],
    }
    Path(args.evidence).write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
