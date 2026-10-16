export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const DOC_MIME = 'application/vnd.google-apps.document';
export const MAX_CV_BYTES = 10 * 1024 * 1024;
const API_ROOT = 'https://www.googleapis.com/drive/v3';
const idPattern = /^[A-Za-z0-9_-]{1,200}$/;

export function parseFolderLink(value) {
  const input = value.trim();
  if (idPattern.test(input)) return { id: input, resourceKey: '' };
  let url;
  try { url = new URL(input); } catch { throw new Error('Paste a Google Drive folder link or folder ID.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'drive.google.com') throw new Error('Use a folder link from drive.google.com.');
  const id = url.pathname.match(/\/folders\/([A-Za-z0-9_-]+)/)?.[1] || url.searchParams.get('id');
  if (!id || !idPattern.test(id)) throw new Error('This link does not contain a valid folder ID.');
  const resourceKey = url.searchParams.get('resourcekey') || '';
  if (resourceKey && !idPattern.test(resourceKey)) throw new Error('Invalid folder resource key.');
  return { id, resourceKey };
}

function checkedId(id) {
  if (!idPattern.test(id)) throw new Error('Invalid Google Drive file ID.');
  return id;
}

async function googleRequest(path, token, params = {}, resource = null) {
  if (!token) throw new Error('Connect Google Drive first.');
  const headers = { Authorization: `Bearer ${token}` };
  if (resource?.resourceKey) headers['X-Goog-Drive-Resource-Keys'] = `${checkedId(resource.id)}/${checkedId(resource.resourceKey)}`;
  let response;
  try {
    response = await fetch(`${API_ROOT}${path}?${new URLSearchParams(params)}`, { headers, signal: AbortSignal.timeout(60000) });
  } catch { throw new Error('Could not reach Google Drive. Check your connection and retry.'); }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(response.status === 401 ? 'Your Google session expired. Reconnect, then retry.' : body.error?.message || 'Google Drive could not complete this request.');
    error.status = response.status;
    throw error;
  }
  return response;
}

export async function folderDetails(token, folder) {
  const data = await (await googleRequest(`/files/${checkedId(folder.id)}`, token,
    { fields: 'id,name,mimeType,trashed', supportsAllDrives: 'true' }, folder)).json();
  if (data.trashed || data.mimeType !== FOLDER_MIME) throw new Error('Choose an existing Google Drive folder.');
  return data;
}

export async function listFolderFiles(token, folder) {
  const files = [];
  let pageToken = '';
  const seen = new Set();
  do {
    const data = await (await googleRequest('/files', token, {
      q: `'${checkedId(folder.id)}' in parents and trashed = false`,
      fields: 'nextPageToken,incompleteSearch,files(id,name,mimeType,size,modifiedTime,resourceKey,capabilities(canDownload))',
      pageSize: '1000', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
      ...(pageToken ? { pageToken } : {}),
    }, folder)).json();
    if (data.incompleteSearch) throw new Error('Google returned an incomplete folder listing. Retry before importing.');
    files.push(...(data.files || []));
    pageToken = data.nextPageToken || '';
    if (pageToken && seen.has(pageToken)) throw new Error('Google returned a repeated page. Reload this folder.');
    seen.add(pageToken);
  } while (pageToken);
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

export function unsupportedReason(file) {
  if (file.mimeType === FOLDER_MIME) return 'Subfolder — map this folder separately';
  if (file.capabilities?.canDownload === false) return 'Download disabled by the file owner';
  if (Number(file.size) > MAX_CV_BYTES) return 'Larger than 10 MB';
  if (file.mimeType !== DOC_MIME && !/\.(pdf|docx)$/i.test(file.name)) return 'Only PDF, DOCX, and Google Docs are supported';
  return '';
}

export function suggestedName(filename) {
  return filename.replace(/\.(pdf|docx)$/i, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

export async function downloadCV(token, file) {
  const reason = unsupportedReason(file);
  if (reason) throw new Error(reason);
  const googleDoc = file.mimeType === DOC_MIME;
  const response = await googleRequest(`/files/${checkedId(file.id)}${googleDoc ? '/export' : ''}`, token,
    googleDoc ? { mimeType: 'application/pdf' } : { alt: 'media', supportsAllDrives: 'true' }, { id: file.id, resourceKey: file.resourceKey });
  if (Number(response.headers.get('content-length')) > MAX_CV_BYTES) {
    await response.body?.cancel();
    throw new Error('This CV is larger than 10 MB.');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_CV_BYTES) { await reader.cancel(); throw new Error('This CV is larger than 10 MB.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const name = googleDoc ? `${file.name.replace(/\.pdf$/i, '')}.pdf` : file.name;
  const type = /\.pdf$/i.test(name) ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  return { blob: new Blob(chunks, { type }), name };
}

let googleLibrary;
export function loadGoogleLibrary() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (!googleLibrary) googleLibrary = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    const timer = setTimeout(() => { script.remove(); googleLibrary = null; reject(new Error('Google sign-in did not load. Check your connection and retry.')); }, 20000);
    script.onload = () => { clearTimeout(timer); resolve(); };
    script.onerror = () => { clearTimeout(timer); script.remove(); googleLibrary = null; reject(new Error('Could not load Google sign-in. Check your connection.')); };
    document.head.appendChild(script);
  });
  return googleLibrary;
}
