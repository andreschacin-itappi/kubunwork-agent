const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

/**
 * Minimal ZIP reader for the agent's own update packages (see
 * build/lib/stage-app.mjs, which always zips them with Python's stdlib
 * zipfile — plain STORE/DEFLATE, no encryption, no ZIP64, single volume).
 *
 * Employee machines cannot be assumed to have Python, an unzip CLI, or
 * PowerShell script execution enabled, so the auto-updater carries this
 * instead of shelling out to any of them. It is deliberately not a
 * general-purpose unzip. The outer .zip download is already SHA-256 verified
 * by the caller before extraction runs, so per-entry CRC32 checking would be
 * redundant.
 */

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

function findEndOfCentralDirectory(buf) {
  const minOffset = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= minOffset; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error("No es un archivo ZIP válido (falta el registro EOCD)");
}

/** Guards against zip-slip: every entry must resolve inside destDir. */
function safeJoin(destDir, entryName) {
  const resolvedDest = path.resolve(destDir);
  const resolvedEntry = path.resolve(destDir, entryName);
  if (resolvedEntry !== resolvedDest && !resolvedEntry.startsWith(resolvedDest + path.sep)) {
    throw new Error(`Entrada de ZIP fuera del destino: ${entryName}`);
  }
  return resolvedEntry;
}

function extractZip(zipPath, destDir) {
  const buf = fs.readFileSync(zipPath);
  const eocd = findEndOfCentralDirectory(buf);
  const entryCount = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);

  fs.mkdirSync(destDir, { recursive: true });

  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(offset) !== CENTRAL_SIG) {
      throw new Error(`Directorio central corrupto en la entrada ${i}`);
    }
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString("utf8", offset + 46, offset + 46 + nameLen);
    offset += 46 + nameLen + extraLen + commentLen;

    const destPath = safeJoin(destDir, name);

    if (name.endsWith("/")) {
      fs.mkdirSync(destPath, { recursive: true });
      continue;
    }

    if (buf.readUInt32LE(localHeaderOffset) !== LOCAL_SIG) {
      throw new Error(`Cabecera local corrupta para ${name}`);
    }
    // The local header's extra-field length can differ from the central
    // directory's, so it has to be read again to find the real data start.
    const localNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const compData = buf.subarray(dataStart, dataStart + compSize);

    let data;
    if (method === 0) data = compData;
    else if (method === 8) data = zlib.inflateRawSync(compData);
    else throw new Error(`Método de compresión ${method} no soportado (${name})`);

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, data);
  }
}

module.exports = { extractZip };
