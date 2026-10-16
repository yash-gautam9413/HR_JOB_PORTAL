import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFolderLink, listFolderFiles, folderDetails, downloadCV, suggestedName, unsupportedReason, DOC_MIME, MAX_CV_BYTES } from './drive-client.js';

test('folder links accept Google IDs but reject other hosts and query injection', () => {
  assert.deepEqual(parseFolderLink('https://drive.google.com/drive/u/0/folders/folder_123?resourcekey=key-456'), { id: 'folder_123', resourceKey: 'key-456' });
  assert.equal(parseFolderLink('folder-123').id, 'folder-123');
  assert.throws(() => parseFolderLink('https://evil.example/folders/id'));
  assert.throws(() => parseFolderLink("folder' or trashed = false"));
});

test('folder listing follows all pages and passes scoped headers', async t => {
  let count = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    assert.equal(options.headers['X-Goog-Drive-Resource-Keys'], 'folder1/key1');
    const params = new URL(url).searchParams;
    assert.equal(params.get('q'), "'folder1' in parents and trashed = false");
    assert.match(params.get('fields'), /modifiedTime/);
    count++;
    if (count === 1) return Response.json({ files: [{ id: 'b', name: 'B.pdf' }], nextPageToken: 'page2' });
    assert.equal(params.get('pageToken'), 'page2');
    return Response.json({ files: [{ id: 'a', name: 'A.pdf', modifiedTime: '2026-09-26T09:00:00Z' }] });
  });
  const files = await listFolderFiles('test-token', { id: 'folder1', resourceKey: 'key1' });
  assert.equal(count, 2);
  assert.deepEqual(files.map(f => f.name), ['A.pdf', 'B.pdf']);
  assert.equal(files[0].modifiedTime, '2026-09-26T09:00:00Z');
});

test('expired sessions and incomplete listings fail visibly', async t => {
  const mock = t.mock.method(globalThis, 'fetch', async () => Response.json({}, { status: 401 }));
  await assert.rejects(() => listFolderFiles('expired', { id: 'folder1' }), error => error.status === 401);
  mock.mock.mockImplementation(async () => Response.json({ incompleteSearch: true, files: [] }));
  await assert.rejects(() => listFolderFiles('token', { id: 'folder1' }), /incomplete/);
});

test('only folders can be mapped and read-only files are unavailable', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ id: 'file1', mimeType: 'application/pdf' }));
  await assert.rejects(() => folderDetails('token', { id: 'file1' }), /folder/);
  assert.match(unsupportedReason({ name: 'cv.pdf', capabilities: { canDownload: false } }), /disabled/);
  assert.match(unsupportedReason({ name: 'cv.doc' }), /supported/);
  assert.equal(suggestedName('Aditi_Sharma.pdf'), 'Aditi Sharma');
});

test('Google Docs are exported to PDF and preserve downloaded bytes', async t => {
  t.mock.method(globalThis, 'fetch', async url => {
    assert.match(url, /\/files\/doc1\/export\?/);
    assert.equal(new URL(url).searchParams.get('mimeType'), 'application/pdf');
    return new Response('%PDF-1.4 google document');
  });
  const result = await downloadCV('token', { id: 'doc1', name: 'Aditi CV', mimeType: DOC_MIME });
  assert.equal(result.name, 'Aditi CV.pdf');
  assert.equal(result.blob.type, 'application/pdf');
  assert.equal(await result.blob.text(), '%PDF-1.4 google document');
});

test('download rejects oversized data even without content-length', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array(MAX_CV_BYTES + 1)));
  await assert.rejects(() => downloadCV('token', { id: 'big', name: 'cv.pdf' }), /10 MB/);
});
