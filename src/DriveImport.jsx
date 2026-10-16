import React, { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowRight, Check, CloudDownload, ExternalLink, FolderOpen, Link2, Plus, RefreshCw, Settings2, Unplug, X } from 'lucide-react';
import { api } from './api';
import { DRIVE_SCOPE, downloadCV, folderDetails, listFolderFiles, loadGoogleLibrary, parseFolderLink, suggestedName, unsupportedReason } from './drive-client';
import './drive.css';
import Pagination from './Pagination';
import { modifiedDate } from './date-format';

export default function DriveImport({ departments, active, onImported, onBusyChange }) {
  const [initialized, setInitialized] = useState(false);
  const [loading, setLoading] = useState(false);
  const [clientId, setClientId] = useState('');
  const [draftClient, setDraftClient] = useState('');
  const [setupOpen, setSetupOpen] = useState(false);
  const [googleReady, setGoogleReady] = useState(false);
  const [session, setSession] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [mappings, setMappings] = useState([]);
  const [imports, setImports] = useState([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyPage, setHistoryPage] = useState(1);
  const [reviewPage, setReviewPage] = useState(1);
  const historyVersion = useRef(0);
  const [folderLink, setFolderLink] = useState('');
  const [department, setDepartment] = useState('');
  const [selectedMapping, setSelectedMapping] = useState(null);
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [role, setRole] = useState('');
  const [progress, setProgress] = useState(null);
  const stopRequested = useRef(false);
  const resourceKeys = useRef(new Map());
  const token = session && session.expiresAt > Date.now() ? session.token : '';
  const selected = rows.filter(row => row.selected && !row.reason && !['imported', 'skipped'].includes(row.result));

  async function refreshLocal() {
    const version = ++historyVersion.current;
    const [folders, history] = await Promise.all([api('/drive/mappings'), api(`/drive/history?page=${historyPage}`)]);
    if (version !== historyVersion.current) return;
    setMappings(folders); setImports(history.items); setHistoryTotal(history.total); setHistoryPage(history.page);
    if (selectedMapping && !folders.some(folder => folder.id === selectedMapping.id)) {
      setSelectedMapping(null); setRows([]);
    }
  }
  async function initializePage() {
    setLoading(true); setError('');
    try {
      const settings = await api('/drive/settings');
      setClientId(settings.client_id); setDraftClient(settings.client_id); setSetupOpen(!settings.client_id);
      await refreshLocal(); setInitialized(true);
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { if (active && !initialized) initializePage(); }, [active]);
  useEffect(() => {
    if (department && !departments.some(d => String(d.id) === String(department))) setDepartment('');
  }, [departments, department]);
  useEffect(() => { if (active && initialized) refreshLocal().catch(showError); }, [active, historyPage]);
  useEffect(() => {
    if (clientId) loadGoogleLibrary().then(() => setGoogleReady(true)).catch(err => setError(err.message));
  }, [clientId]);
  useEffect(() => {
    if (!session) return;
    const timer = setTimeout(() => { setSession(null); setNotice('Google session expired. Reconnect to continue; imported CVs are already saved.'); }, Math.max(0, session.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [session]);
  useEffect(() => {
    onBusyChange(!!busy);
    if (!busy) return;
    const warn = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy, onBusyChange]);

  function showError(err) {
    setError(err.message);
    if (err.status === 401) setSession(null);
  }
  async function saveSettings(event) {
    event.preventDefault(); setBusy('settings'); setError('');
    try {
      const result = await api('/drive/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: draftClient.trim() }) });
      setSession(null); setClientId(result.client_id); setSetupOpen(false); setNotice('Google client ID saved. You can now connect your account.');
    } catch (err) { showError(err); }
    finally { setBusy(''); }
  }
  function connect() {
    setError(''); setNotice(''); setConnecting(true);
    try {
      const client = window.google.accounts.oauth2.initTokenClient({
        client_id: clientId, scope: DRIVE_SCOPE, include_granted_scopes: false,
        callback: response => {
          setConnecting(false);
          if (response.error || !response.access_token) { setError('Google connection was not completed. Please try again.'); return; }
          if (!window.google.accounts.oauth2.hasGrantedAllScopes(response, DRIVE_SCOPE)) { setError('Read-only Drive access is needed to list and import existing folder contents.'); return; }
          setSession({ token: response.access_token, expiresAt: Date.now() + Math.max(0, Number(response.expires_in) - 30) * 1000 });
          setNotice('Google Drive connected. Add a department folder or review a saved mapping.');
        },
        error_callback: () => { setConnecting(false); setError('Google sign-in was closed or blocked. Allow the popup and try again.'); },
      });
      client.requestAccessToken({ prompt: 'select_account' });
    } catch (err) { setConnecting(false); showError(err); }
  }
  function disconnect() {
    if (session?.token) window.google?.accounts?.oauth2?.revoke(session.token, () => {});
    setSession(null); setRows([]); setSelectedMapping(null); setNotice('Disconnected. Imported CVs and folder mappings remain saved.');
  }

  async function mapFolder(event) {
    event.preventDefault(); setBusy('mapping'); setError(''); setNotice('');
    try {
      const folder = parseFolderLink(folderLink);
      const details = await folderDetails(token, folder);
      const saved = await api('/drive/mappings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder_id: details.id, folder_name: details.name, resource_key: folder.resourceKey, department_id: Number(department || departments[0]?.id) }) });
      resourceKeys.current.set(details.id, folder.resourceKey);
      setFolderLink(''); setRows([]); setSelectedMapping(null);
      await refreshLocal();
      setNotice(`“${details.name}” linked to ${departments.find(d => d.id === saved.department_id)?.name}. Click Review CVs to choose what to import.`);
    } catch (err) { showError(err); }
    finally { setBusy(''); }
  }
  async function review(mapping) {
    setReviewPage(1);
    setBusy('review'); setError(''); setNotice(''); setRows([]); setSelectedMapping(null); setProgress(null);
    try {
      const folder = { id: mapping.folder_id, resourceKey: mapping.resource_key || resourceKeys.current.get(mapping.folder_id) || '' };
      await folderDetails(token, folder);
      const files = await listFolderFiles(token, folder);
      const importedIds = new Set();
      for (let offset = 0; offset < files.length; offset += 1000) {
        const result = await api('/drive/check-imported', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(files.slice(offset, offset + 1000).map(file => file.id)) });
        result.ids.forEach(id => importedIds.add(id));
      }
      setRows(files.map(file => {
        const reason = unsupportedReason(file);
        const imported = importedIds.has(file.id);
        return { file, name: suggestedName(file.name), email: '', reason, selected: !reason && !imported, result: imported ? 'skipped' : '', message: '' };
      }));
      setSelectedMapping(mapping); setRole('');
    } catch (err) { showError(err); }
    finally { setBusy(''); }
  }
  async function unlink(mapping) {
    setBusy('unlink'); setError('');
    try {
      await api(`/drive/mappings/${mapping.id}`, { method: 'DELETE' });
      if (selectedMapping?.id === mapping.id) { setSelectedMapping(null); setRows([]); }
      await refreshLocal(); setNotice('Folder unlinked. Existing candidates and CVs were kept.');
    } catch (err) { showError(err); }
    finally { setBusy(''); }
  }
  function updateRow(id, changes) { setRows(previous => previous.map(row => row.file.id === id ? { ...row, ...changes } : row)); }
  async function importFiles(event) {
    event.preventDefault();
    if (!selected.length || !token) return;
    setBusy('import'); setError(''); setNotice(''); stopRequested.current = false;
    const batch = [...selected];
    let imported = 0, skipped = 0, failed = 0, processed = 0;
    setProgress({ done: 0, total: batch.length });
    try {
      for (const row of batch) {
        if (stopRequested.current) break;
        updateRow(row.file.id, { result: 'working', message: '' });
        try {
          const download = await downloadCV(token, row.file);
          const data = new FormData();
          data.set('mapping_id', selectedMapping.id); data.set('file_id', row.file.id);
          data.set('name', row.name); data.set('email', row.email); data.set('role', role);
          data.set('cv', download.blob, download.name);
          if (row.file.modifiedTime) data.set('modified_time', row.file.modifiedTime);
          const result = await api('/drive/import', { method: 'POST', body: data });
          if (result.status === 'imported') imported++; else skipped++;
          updateRow(row.file.id, { result: result.status, selected: false });
        } catch (err) {
          failed++; updateRow(row.file.id, { result: 'failed', message: err.message });
          if (err.status === 401) { showError(err); stopRequested.current = true; }
        }
        processed++; setProgress({ done: processed, total: batch.length });
      }
      const remaining = batch.length - processed;
      setNotice(`${imported} imported · ${skipped} already saved · ${failed} failed${remaining ? ` · ${remaining} not processed` : ''}. Successfully imported CVs are saved in the database.`);
      await refreshLocal(); await onImported();
    } catch (err) { showError(err); }
    finally { setBusy(''); }
  }

  if (loading) return <div className="loading-state"><span className="spinner"/>Loading Drive import…</div>;
  return <div className="drive-page">
    {error && <div className="drive-message error" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}><X size={16}/></button></div>}
    {notice && <div className="drive-message" role="status"><Check size={17}/><span>{notice}</span></div>}
    {!initialized && <button className="button secondary" onClick={initializePage}>Retry loading settings</button>}
    <section className="panel drive-connect"><div className="drive-connect-icon"><CloudDownload size={28}/></div><div className="drive-connect-text"><h2>Bring your talent pool together</h2><p>Connect Google Drive, map each department folder, then review and import your CVs.</p><small>Read-only Google permission can view all files in the connected Drive. This app lists folders you choose and imports only selected CVs. Originals stay in Drive.</small></div><div className="drive-connect-actions">{token ? <><span className="drive-connected"><Check size={14}/>Connected for this session</span><button className="button secondary" disabled={!!busy} onClick={disconnect}><Unplug size={15}/>Disconnect</button></> : <button className="button primary" disabled={!clientId || !googleReady || !!busy || connecting} onClick={connect}><Link2 size={16}/>{connecting ? 'Connecting…' : 'Connect Google Drive'}</button>}<button className="text-button" disabled={!!busy} onClick={() => setSetupOpen(!setupOpen)}><Settings2 size={14}/>{clientId ? 'Connection setup' : 'Set up Google connection'}</button></div></section>

    {setupOpen && <section className="panel drive-setup"><div className="section-heading"><div><h2>One-time Google setup</h2><p>Use a Google Cloud OAuth client for this local dashboard. No client secret is needed.</p></div><a className="text-button" href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noreferrer">Google Cloud<ExternalLink size={14}/></a></div><ol><li>Create or select a Google Cloud project and enable the <strong>Google Drive API</strong>.</li><li>Configure the OAuth consent screen. For an external app in Testing, add your Google account under <strong>Test users</strong> and add the <code>drive.readonly</code> scope.</li><li>Create an OAuth client of type <strong>Web application</strong>. Add <code>http://localhost</code> and <code>http://localhost:8000</code> to Authorized JavaScript origins. For Vite development, also add <code>http://localhost:5173</code>.</li><li>Open the dashboard at <a href="http://localhost:8000">localhost:8000</a>, paste the client ID below, then connect your Google account.</li></ol><p className="drive-help">Folder import needs the Drive read-only scope. Google classifies it as restricted; external production use may require verification. <a href="https://developers.google.com/workspace/drive/api/guides/api-specific-auth" target="_blank" rel="noreferrer">Google scope guidance ↗</a></p><form onSubmit={saveSettings} className="drive-setup-form"><label>Google OAuth Client ID<input value={draftClient} onChange={e => setDraftClient(e.target.value)} required maxLength={240} placeholder="123456789-abc.apps.googleusercontent.com" disabled={!!busy}/></label><button className="button primary" disabled={!!busy}>{busy === 'settings' ? 'Saving…' : 'Save client ID'}</button></form>{clientId && !googleReady && <button className="text-button" onClick={() => loadGoogleLibrary().then(() => setGoogleReady(true)).catch(showError)}>Retry loading Google sign-in</button>}</section>}

    {window.location.hostname === '127.0.0.1' && <div className="drive-message"><span>For Google login, open this workspace at <a href="http://localhost:8000">http://localhost:8000</a>. Register that address in your Google OAuth client.</span></div>}

    <section className="panel drive-mapping"><div className="section-heading"><div><h2>Department folders<span className="count-pill">{mappings.length}</span></h2><p>One folder can map to one department. You can add several folders for the same department.</p></div></div><form className="drive-map-form" onSubmit={mapFolder}><label>Google Drive folder link<input value={folderLink} onChange={e => setFolderLink(e.target.value)} disabled={!token || !!busy} required placeholder="https://drive.google.com/drive/folders/…" maxLength={1000}/></label><label>Import into department<select value={department || departments[0]?.id || ''} onChange={e => setDepartment(e.target.value)} disabled={!token || !!busy}>{departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label><button className="button primary" disabled={!token || !!busy}><Plus size={16}/>{busy === 'mapping' ? 'Checking folder…' : 'Link folder'}</button></form><p className="drive-help">Paste each department folder once. Files directly inside it are listed; nested folders can be mapped separately. Changing a mapping affects future imports only.</p>
      {mappings.length ? <div className="drive-mappings">{mappings.map(mapping => <div className="drive-mapping-row" key={mapping.id}><span className="department-icon blue"><FolderOpen size={22}/></span><div className="drive-folder-title"><strong>{mapping.folder_name}</strong><small>{mapping.imported_count} CVs imported</small></div><ArrowRight className="drive-mapping-arrow" size={17}/><span className="drive-department">{mapping.department_name}</span><button className="button secondary" disabled={!token || !!busy} onClick={() => review(mapping)}><RefreshCw size={14}/>Review CVs</button><button className="icon-button" aria-label={`Unlink ${mapping.folder_name}`} disabled={!!busy} onClick={() => unlink(mapping)}><X size={16}/></button></div>)}</div> : <div className="empty-state compact"><FolderOpen size={30}/><h3>Your folders, your departments</h3><p>Connect Google Drive, then link your AI, SEO, Creative, and other CV folders here.</p></div>}
    </section>

    {busy === 'review' && <div className="loading-state"><span className="spinner"/>Reading folder contents…</div>}
    {selectedMapping && <section className="panel drive-review"><div className="section-heading"><div><h2>Review: {selectedMapping.folder_name}</h2><p>{rows.length} items · importing into {selectedMapping.department_name}</p></div><span className="drive-department">{selected.length} selected</span></div><p className="drive-help">Names are suggested from filenames, not extracted from CVs. Review them before importing. Email is optional; missing details can be added later. PDF, DOCX, and Google Docs (as PDF), up to 10 MB each.</p><form onSubmit={importFiles}><fieldset disabled={!!busy} className="drive-review-fields"><div className="drive-review-toolbar"><label className="drive-checkbox"><input type="checkbox" checked={selected.length > 0 && selected.length === rows.filter(r => !r.reason && !['imported', 'skipped'].includes(r.result)).length} onChange={e => setRows(previous => previous.map(r => ({ ...r, selected: !r.reason && !['imported', 'skipped'].includes(r.result) && e.target.checked })))}/>Select all available CVs across all pages</label><label className="drive-role">Role for this batch (optional)<input value={role} onChange={e => setRole(e.target.value)} maxLength={120} placeholder="e.g. SEO Executive"/></label></div><div className="table-wrap"><table><thead><tr><th>Select</th><th>Drive file</th><th>Date modified</th><th>Candidate name</th><th>Email (optional)</th><th>Import status</th></tr></thead><tbody>{rows.slice((reviewPage - 1) * 100, reviewPage * 100).map(row => <tr key={row.file.id}><td><input aria-label={`Select ${row.file.name}`} type="checkbox" className="drive-file-checkbox" checked={row.selected} disabled={!!row.reason || ['imported', 'skipped'].includes(row.result)} onChange={e => updateRow(row.file.id, { selected: e.target.checked })}/></td><td className="drive-filename"><a href={`https://drive.google.com/file/d/${encodeURIComponent(row.file.id)}/view`} target="_blank" rel="noreferrer">{row.file.name}<ExternalLink size={12}/></a>{row.reason && <small>{row.reason}</small>}</td><td className="date-cell">{modifiedDate(row.file.modifiedTime)}</td><td><input aria-label={`Candidate name for ${row.file.name}`} value={row.name} maxLength={120} required={row.selected} disabled={!row.selected} onChange={e => updateRow(row.file.id, { name: e.target.value })}/></td><td><input aria-label={`Email for ${row.file.name}`} type="email" maxLength={254} value={row.email} disabled={!row.selected} onChange={e => updateRow(row.file.id, { email: e.target.value })} placeholder="Add later"/></td><td className="drive-result"><span className={`drive-result-label ${row.result}`}>{row.result === 'skipped' ? 'Already saved' : row.result === 'imported' ? 'Imported' : row.result === 'working' ? 'Importing…' : row.result === 'failed' ? 'Failed — retry' : row.reason ? 'Unavailable' : 'Ready'}</span>{row.message && <small>{row.message}</small>}</td></tr>)}</tbody></table></div><Pagination page={reviewPage} total={rows.length} onChange={setReviewPage} disabled={!!busy} label="files"/>{!rows.length && <div className="empty-state compact"><h3>This folder is empty</h3><p>Choose another department folder.</p></div>}<div className="drive-import-actions"><span>Existing Drive file IDs are skipped automatically.</span><button className="button primary" disabled={!token || !selected.length}><ArrowDownToLine size={16}/>Import {selected.length} selected CVs</button></div></fieldset></form>{progress && <div className="drive-progress" role="status"><progress value={progress.done} max={progress.total}/><span>{progress.done} / {progress.total} processed</span>{busy === 'import' && <button className="button secondary small" onClick={() => { stopRequested.current = true; setNotice('Stopping after the current file. Completed imports will be kept.'); }}>Stop after current file</button>}</div>}</section>}

    {historyTotal > 0 && <section className="panel drive-history"><div className="section-heading"><div><h2>Recent Drive imports</h2><p>{historyTotal} CVs saved from Google Drive</p></div></div><div className="table-wrap"><table><thead><tr><th>Candidate</th><th>Department</th><th>CV</th><th>Date modified (Drive)</th><th>Imported</th></tr></thead><tbody>{imports.map(item => <tr key={item.file_id}><td>{item.name}</td><td>{item.department_name}</td><td><a className="cv-link" href={`/api/candidates/${item.candidate_id}/cv`} target="_blank" rel="noreferrer">{item.cv_name}</a></td><td className="date-cell">{modifiedDate(item.modified_time)}</td><td>{new Date(item.imported_at).toLocaleDateString('en-IN')}</td></tr>)}</tbody></table></div><Pagination page={historyPage} total={historyTotal} onChange={setHistoryPage} disabled={!!busy} label="imports"/></section>}
  </div>;
}
