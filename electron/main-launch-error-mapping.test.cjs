/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

// CONCURRENCY-3 regression guard.
//
// getArchiveBayLibrary() and loadRecompState() return an empty state only on
// ENOENT and RE-THROW the raw Node error on every other read failure
// (EACCES/EISDIR/EIO) — and that raw message embeds the absolute path of the
// userData state.json. ipcMain serializes a thrown handler error's .message
// back to the renderer's invoke() rejection, so a read handler that awaits one
// of these OUTSIDE a mapping try/catch leaks that path to the renderer, breaking
// the module invariant ("never forward a raw path ... to the renderer",
// archiveBayErrorMessage / archiveBayRecompErrorMessage).
//
// Shipped 16.x awaited these reads un-try/caught in five renderer-reachable
// handlers. This guard fails if any of them stops mapping the read error.

const source = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");

// Extract one ipcMain.handle("<channel>", ...) body: from the channel marker to
// the NEXT `ipcMain.handle(`. The next handler is the delimiter on purpose — a
// fixed-size character window can overrun into a neighbouring handler and let a
// sibling satisfy an assertion, the exact flaw that made the recomp-IPC source
// scan unsound (review finding F1). One handler's assertions can only be
// satisfied by that handler's own text.
function handlerBody(channel) {
  const marker = `ipcMain.handle("${channel}"`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `handler ${channel} not found in main.cjs`);
  const next = source.indexOf("ipcMain.handle(", start + marker.length);
  return source.slice(start, next === -1 ? source.length : next);
}

const norm = (s) => s.replace(/\s+/g, " ");

const GUARDED = [
  { channel: "archive-bay:list", read: "await getArchiveBayLibrary()", mapper: "archiveBayErrorMessage(error)" },
  { channel: "archive-bay:launch", read: "await getArchiveBayLibrary()", mapper: "archiveBayErrorMessage(error)" },
  { channel: "archive-bay:remove", read: "await getArchiveBayLibrary()", mapper: "archiveBayErrorMessage(error)" },
  { channel: "archive-bay:runtime-status", read: "await getArchiveBayLibrary()", mapper: "archiveBayErrorMessage(error)" },
  { channel: "archive-bay:recomp:launch", read: "await loadRecompState(", mapper: "archiveBayRecompErrorMessage(error)" },
];

for (const { channel, read, mapper } of GUARDED) {
  test(`${channel} maps a raw state-read error to a coded, path-free one`, () => {
    const body = norm(handlerBody(channel));
    const codedCatch = `} catch (error) { throw new Error(${mapper}); }`;

    const iTry = body.indexOf("try {");
    const iRead = body.indexOf(read);
    const iCatch = body.indexOf(codedCatch);

    assert.notEqual(iRead, -1, `${channel}: expected a state read (${read})`);
    assert.notEqual(iTry, -1, `${channel}: the state read must be inside a try`);
    assert.notEqual(iCatch, -1, `${channel}: expected a catch mapping through ${mapper}`);
    // try opens, THEN the read happens, THEN the coded catch — i.e. the read is
    // wrapped by a try whose catch strips the raw error to a code.
    assert.ok(
      iTry < iRead && iRead < iCatch,
      `${channel}: the state read is not wrapped by the mapping try/catch (try@${iTry} read@${iRead} catch@${iCatch})`,
    );
  });
}
