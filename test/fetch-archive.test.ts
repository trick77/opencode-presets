import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { ARCHIVE_MARKER, fetchArchive, readTar } from '../src/fetch-archive.js';

type Entry = { name: string; type?: string; body?: string; mode?: number };

// Just enough of ustar to build fixtures: name, mode, size, typeflag, magic, checksum.
function tarOf(entries: Entry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const body = Buffer.from(e.body ?? '');
    const h = Buffer.alloc(512);
    h.write(e.name, 0, 100, 'utf8');
    h.write((e.mode ?? 0o644).toString(8).padStart(7, '0') + '\0', 100, 'latin1');
    h.write(body.length.toString(8).padStart(11, '0') + '\0', 124, 'latin1');
    h.write(e.type ?? '0', 156, 'latin1');
    h.write('ustar\0' + '00', 257, 'latin1');
    h.fill(0x20, 148, 156);
    const sum = h.reduce((n, b) => n + b, 0);
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
    blocks.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const tarSha = (tgz: Buffer) => sha(gunzipSync(tgz));

const realFetch = globalThis.fetch;
let requests = 0;
function serve(buf: Buffer) {
  requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    return new Response(new Uint8Array(buf));
  }) as typeof fetch;
}
afterEach(() => { globalThis.fetch = realFetch; });

const fixture = () => tarOf([
  { name: 'repo-abc/', type: '5' },
  { name: 'repo-abc/README.md', body: 'top' },
  { name: 'repo-abc/skills/', type: '5' },
  { name: 'repo-abc/skills/tool/SKILL.md', body: 'skill' },
  { name: 'repo-abc/skills/tool/scripts/run.py', body: 'print(1)', mode: 0o755 },
]);

describe('fetchArchive', () => {
  test('unpacks only subdir, strips the top-level dir, writes the marker', async () => {
    const dest = join(await mkdtemp(join(tmpdir(), 'archive-')), 'out');
    const tgz = fixture();
    serve(tgz);

    const r = await fetchArchive({ url: 'https://x/a.tar.gz', dest, tarSha256: tarSha(tgz), subdir: 'skills' });

    assert.equal(r.cached, false);
    assert.equal(r.files, 2);
    assert.equal(await readFile(join(dest, 'tool/SKILL.md'), 'utf8'), 'skill');
    assert.ok((await stat(join(dest, 'tool/scripts/run.py'))).mode & 0o100, 'executable bit kept');
    assert.deepEqual((await readdir(dest)).sort(), [ARCHIVE_MARKER, 'tool']);
    assert.equal((await readFile(join(dest, ARCHIVE_MARKER), 'utf8')).trim(), `${tarSha(tgz)} skills`);
  });

  test('second run with the same tar-sha256 is a cache hit, no download', async () => {
    const dest = join(await mkdtemp(join(tmpdir(), 'archive-')), 'out');
    const tgz = fixture();
    serve(tgz);
    await fetchArchive({ url: 'https://x/a.tar.gz', dest, tarSha256: tarSha(tgz), subdir: null });

    serve(tgz);
    const r = await fetchArchive({ url: 'https://x/a.tar.gz', dest, tarSha256: tarSha(tgz), subdir: null });
    assert.equal(r.cached, true);
    assert.equal(requests, 0);
  });

  test('tar-sha256 mismatch refuses and leaves no dest behind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'archive-'));
    serve(fixture());
    await assert.rejects(
      fetchArchive({ url: 'https://x/a.tar.gz', dest: join(dir, 'out'), tarSha256: 'f'.repeat(64), subdir: null }),
      /tar-sha256 mismatch/,
    );
    assert.deepEqual(await readdir(dir), []);
  });

  for (const [label, entry, re] of [
    ['a path climbing out with ..', { name: 'repo-abc/../../evil', body: 'x' }, /unsafe path/],
    ['an absolute path', { name: '/etc/evil', body: 'x' }, /unsafe path/],
    ['a symlink', { name: 'repo-abc/link', type: '2' }, /only files and directories/],
    ['a hardlink', { name: 'repo-abc/hard', type: '1' }, /only files and directories/],
  ] as const) {
    test(`refuses an archive with ${label}`, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'archive-'));
      const tgz = tarOf([{ name: 'repo-abc/ok', body: 'ok' }, entry]);
      serve(tgz);
      await assert.rejects(
        fetchArchive({ url: 'https://x/a.tar.gz', dest: join(dir, 'out'), tarSha256: tarSha(tgz), subdir: null }),
        re,
      );
      assert.deepEqual(await readdir(dir), []);
    });
  }

  test('a subdir with no files is an error, not an empty skill dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'archive-'));
    const tgz = fixture();
    serve(tgz);
    await assert.rejects(
      fetchArchive({ url: 'https://x/a.tar.gz', dest: join(dir, 'out'), tarSha256: tarSha(tgz), subdir: 'nope' }),
      /no files under nope\//,
    );
  });

  test('the hash covers the tar, so a recompressed download still installs', async () => {
    const dest = join(await mkdtemp(join(tmpdir(), 'archive-')), 'out');
    const tgz = fixture();
    const recompressed = gzipSync(gunzipSync(tgz), { level: 1 });
    assert.notEqual(sha(recompressed), sha(tgz));
    serve(recompressed);
    const r = await fetchArchive({ url: 'https://x/a.tar.gz', dest, tarSha256: tarSha(tgz), subdir: null });
    assert.equal(r.cached, false);
  });

  test('a trailing slash on dest unpacks into dest, not into a temp dir inside it', async () => {
    const dest = join(await mkdtemp(join(tmpdir(), 'archive-')), 'out');
    const tgz = fixture();
    serve(tgz);
    await fetchArchive({ url: 'https://x/a.tar.gz', dest: dest + '/', tarSha256: tarSha(tgz), subdir: 'skills' });
    assert.equal(await readFile(join(dest, 'tool/SKILL.md'), 'utf8'), 'skill');
  });

  test('a changed subdir re-extracts instead of counting as a cache hit', async () => {
    const dest = join(await mkdtemp(join(tmpdir(), 'archive-')), 'out');
    const tgz = fixture();
    serve(tgz);
    await fetchArchive({ url: 'https://x/a.tar.gz', dest, tarSha256: tarSha(tgz), subdir: null });

    serve(tgz);
    const r = await fetchArchive({ url: 'https://x/a.tar.gz', dest, tarSha256: tarSha(tgz), subdir: 'skills' });
    assert.equal(r.cached, false);
    assert.deepEqual((await readdir(dest)).sort(), [ARCHIVE_MARKER, 'tool']);
  });
});

describe('readTar', () => {
  test('an old-GNU header does not read atime bytes as a path prefix', () => {
    const h = Buffer.alloc(512);
    h.write('repo/a.md', 0, 'utf8');
    h.write('0000644\0', 100, 'latin1');
    h.write('00000000000\0', 124, 'latin1');
    h.write('0', 156, 'latin1');
    h.write('ustar  \0', 257, 'latin1');
    h.write('14444444444\0', 345, 'latin1'); // atime in old GNU
    const [e] = readTar(Buffer.concat([h, Buffer.alloc(1024)]));
    assert.equal(e.path, 'repo/a.md');
  });
});
