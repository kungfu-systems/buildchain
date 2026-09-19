import fs from "node:fs";

// Bounded format admission only. These headers do not prove a valid native
// signature, notarization, installation, or product qualification. Those are
// separate provider and product gates; never execute an installer to inspect it.
export function inspectNativeInstaller(file) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const read = (offset, length) => {
      if (offset < 0 || offset + length > size)
        throw new Error("Native installer has a truncated format header");
      const bytes = Buffer.alloc(length);
      if (fs.readSync(fd, bytes, 0, length, offset) !== length)
        throw new Error("Native installer changed during format inspection");
      return bytes;
    };
    if (file.endsWith(".dmg")) {
      const trailer = read(size - 512, 512);
      if (
        trailer.toString("ascii", 0, 4) !== "koly" ||
        trailer.readUInt32BE(4) !== 4 ||
        trailer.readUInt32BE(8) !== 512
      )
        throw new Error("Native DMG installer requires a UDIF trailer");
      return { file, suffix: ".dmg" };
    }
    if (file.endsWith(".exe")) {
      const dos = read(0, 64);
      if (dos.toString("ascii", 0, 2) !== "MZ")
        throw new Error("Native EXE installer requires a PE image");
      const offset = dos.readUInt32LE(60);
      const pe = read(offset, 26);
      if (
        offset < 64 ||
        pe.readUInt32LE(0) !== 0x4550 ||
        ![0x10b, 0x20b].includes(pe.readUInt16LE(24))
      )
        throw new Error("Native EXE installer requires a PE image");
      return { file, suffix: ".exe" };
    }
    if (file.endsWith(".AppImage")) {
      const header = read(0, 64);
      if (
        !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
        ![1, 2].includes(header[4]) ||
        ![1, 2].includes(header[5]) ||
        header[6] !== 1 ||
        header[8] !== 0x41 ||
        header[9] !== 0x49 ||
        ![1, 2].includes(header[10])
      )
        throw new Error(
          "Native AppImage installer requires an ELF AppImage header",
        );
      return { file, suffix: ".AppImage" };
    }
    throw new Error("Unsupported native installer format");
  } finally {
    fs.closeSync(fd);
  }
}
