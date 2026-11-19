import { deflateRawSync } from "node:zlib";

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
/** Bounded archive with generated flat filenames; never accepts paths from upload names. */
export function createPropertyPortalZip(entries: Record<string, string | Uint8Array>) {
  const names = Object.keys(entries);
  if (names.length > 25 || names.some((name) => !/^[a-zA-Z0-9_.-]{1,100}$/.test(name))) throw new Error("INVALID_PORTAL_ARCHIVE_NAME");
  const locals: Buffer[] = [], centrals: Buffer[] = []; let offset = 0, total = 0;
  for (const name of names) {
    const filename = Buffer.from(name), data = Buffer.from(entries[name]); total += data.byteLength;
    if (total > 25 * 1024 * 1024) throw new Error("PORTAL_ARCHIVE_TOO_LARGE");
    const payload = deflateRawSync(data), local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(payload.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(data), 16); central.writeUInt32LE(payload.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, filename, payload); centrals.push(central, filename); offset += local.length + filename.length + payload.length;
  }
  const central = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(names.length, 8); end.writeUInt16LE(names.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}
