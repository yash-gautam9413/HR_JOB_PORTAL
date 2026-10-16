import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowDownToLine, ArrowRight, ArrowUpRight, Bot, Building2, Check, CloudDownload, Code2, FileText, FolderOpen, LayoutDashboard, Megaphone, Palette, Pencil, Plus, Search, ShieldCheck, ShoppingBag, Sparkles, Trash2, UploadCloud, Users, X } from 'lucide-react';
import { api } from './api';
import DriveImport from './DriveImport';
import './styles.css';
import Pagination from './Pagination';
import { modifiedDate } from './date-format';

const statuses = ['New', 'Screening', 'Interview', 'Offer', 'Hired', 'Rejected'];
const departmentIcons = { AI: Bot, SEO: Search, 'CONTENT WRITING': FileText, CREATIVE: Palette, MARKETING: Megaphone, SHOPIFY: ShoppingBag, 'FULL STACK': Code2 };
const initials = name => name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase();
const date = value => new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

function Modal({ title, description, onClose, children, wide = false, className = '' }) {
  const ref = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    ref.current.showModal();
    return () => { previous?.focus(); };
  }, []);
  return <dialog ref={ref} className={`modal ${wide ? 'wide' : ''} ${className}`} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === ref.current) onClose(); }}>
    <div className="modal-heading"><div><h2>{title}</h2>{description && <p>{description}</p>}</div><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={20}/></button></div>
    {children}
  </dialog>;
}

function CandidateForm({ candidate, departments, departmentId, onClose, onSaved }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [fileName, setFileName] = useState('');
  async function submit(event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const cv = data.get('cv');
    if (!cv?.name) data.delete('cv');
    else if (!cv.size) { setError('The selected CV is empty. Please choose another file.'); return; }
    if (cv?.size > 10 * 1024 * 1024) { setError('Please choose a CV smaller than 10 MB.'); return; }
    setSaving(true); setError('');
    try {
      await api(candidate ? `/candidates/${candidate.id}` : '/candidates', { method: candidate ? 'PUT' : 'POST', body: data });
      await onSaved(candidate ? 'Candidate updated' : 'Candidate added');
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  }
  return <Modal title={candidate ? 'Edit candidate' : 'Add a candidate'} description="A new connection. A possible next chapter." onClose={() => !saving && onClose()}>
    <form onSubmit={submit}>
      <fieldset disabled={saving} className="form-fields">
        {!departments.length && <p className="form-error">Create a department before adding a candidate.</p>}
        <div className="form-grid">
          <label>Full name <span>*</span><input autoFocus name="name" required maxLength={120} placeholder="e.g. Aditi Sharma" defaultValue={candidate?.name}/></label>
          <label>Email address (optional)<input type="email" name="email" maxLength={254} placeholder="candidate@example.com" defaultValue={candidate?.email}/></label>
          <label>Role applied for <span>*</span><input name="role" required maxLength={120} placeholder="e.g. Frontend Developer" defaultValue={candidate?.role}/></label>
          <label>Department <span>*</span><select name="department_id" required defaultValue={candidate?.department_id || departmentId || departments[0]?.id}>{departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
          <label>Phone number<input type="tel" name="phone" maxLength={40} placeholder="+91 98765 43210" defaultValue={candidate?.phone}/></label>
          <label>Experience (years)<input type="number" name="experience" min="0" max="60" step="0.5" defaultValue={candidate?.experience ?? 0}/></label>
          <label className="full">Application status<select name="status" defaultValue={candidate?.status || 'New'}>{statuses.map(status => <option key={status}>{status}</option>)}</select></label>
          <label className="full">CV / résumé<span className="upload-zone"><UploadCloud size={25}/><strong>{fileName || (candidate?.cv_name ? 'Choose a replacement CV' : 'Choose a CV to upload')}</strong><small>PDF or DOCX · up to 10 MB</small><input aria-label="Upload CV" type="file" name="cv" accept=".pdf,.docx" onChange={e => setFileName(e.target.files[0]?.name || '')}/></span>{candidate?.cv_name && <small className="muted">Current: {candidate.cv_name}. Leave empty to keep it.</small>}</label>
          <label className="full">Notes<textarea name="notes" rows="3" maxLength={5000} placeholder="Skills, portfolio links, or things to remember…" defaultValue={candidate?.notes}/></label>
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button className="button primary" disabled={saving}>{saving ? 'Saving…' : candidate ? 'Save changes' : 'Add candidate'}<Check size={16}/></button></div>
      </fieldset>
    </form>
  </Modal>;
}

function DepartmentForm({ onClose, onSaved }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function submit(event) {
    event.preventDefault(); setSaving(true); setError('');
    try {
      await api('/departments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
      await onSaved('Department created');
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  }
  return <Modal title="Create a department" description="Give your next great team a place to grow." onClose={() => !saving && onClose()}>
    <form onSubmit={submit}><fieldset disabled={saving} className="form-fields"><label>Department name <span>*</span><input autoFocus name="name" placeholder="e.g. Customer Success" required maxLength={80}/></label><label>Description<textarea name="description" placeholder="What does this team do?" rows="3" maxLength={200}/></label>{error && <p role="alert" className="form-error">{error}</p>}<div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button className="button primary">{saving ? 'Creating…' : 'Create department'}<Plus size={16}/></button></div></fieldset></form>
  </Modal>;
}

function CandidateDetail({ candidate, onClose, onEdit, onDelete }) {
  return <Modal wide className="candidate-cv-modal" title="Candidate profile" description={`Added ${date(candidate.created_at)}`} onClose={onClose}>
    <div className="profile-top">
      <div className={`avatar large ${candidate.department_color}`}>{initials(candidate.name)}</div>
      <div><h2>{candidate.name}</h2><p>{candidate.department_name}</p></div>
      <span className={`status ${candidate.status.toLowerCase()}`}>{candidate.status}</span>
    </div>
    <section aria-label="Candidate overview">
      <div className="cv-overview-heading">Overview</div>
      <div className="cv-body">
        {candidate.cv_name ? <>
          <div className="cv-toolbar">
            <span><FileText size={16}/>{candidate.cv_name}</span>
            <a className="button secondary small" href={`/api/candidates/${candidate.id}/cv?download=true`}><ArrowDownToLine size={15}/>Download CV</a>
          </div>
          {candidate.cv_type === 'application/pdf' ? <>
            <iframe title={`${candidate.name} CV`} src={`/api/candidates/${candidate.id}/cv#toolbar=0&view=FitH`}/>
            <p className="muted">If the preview is unavailable, use Download CV to open the file.</p>
          </> : <div className="empty-state compact">
            <FileText size={36}/><h3>Your CV is ready</h3>
            <p>This CV is a DOCX file. Use Download CV to open it in Word.</p>
          </div>}
        </> : <div className="empty-state compact">
          <UploadCloud size={36}/><h3>No CV uploaded yet</h3>
          <p>Add a CV to see it directly in this overview.</p>
          <button className="button primary" onClick={onEdit}>Upload CV</button>
        </div>}
      </div>
    </section>
    <div className="modal-actions spread">
      <button className="button danger-text" onClick={onDelete}><Trash2 size={16}/>Delete candidate</button>
      <button className="button primary" onClick={onEdit}><Pencil size={16}/>Edit candidate</button>
    </div>
  </Modal>;
}

function App() {
  const [page, setPage] = useState('overview');
  const [driveBusy, setDriveBusy] = useState(false);
  const [departments, setDepartments] = useState([]);
  const [candidates, setCandidates] = useState([]);
  const [summary, setSummary] = useState({ total: 0, cvs: 0, active: 0 });
  const [resultTotal, setResultTotal] = useState(0);
  const [pageState, setPageState] = useState({ key: '', number: 1 });
  const [loadedKey, setLoadedKey] = useState('');
  const [listLoading, setListLoading] = useState(false);
  const [selectionLoading, setSelectionLoading] = useState(false);
  const requestVersion = useRef(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [query, setQuery] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [status, setStatus] = useState('');
  const [sort, setSort] = useState('recent');
  const [modal, setModal] = useState(null);
  const [selected, setSelected] = useState(null);
  const [toast, setToast] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [checkedIds, setCheckedIds] = useState(new Set());
  const [deleteTargets, setDeleteTargets] = useState([]);
  const [departmentToDelete, setDepartmentToDelete] = useState(null);
  const filterKey = JSON.stringify([page, departmentId, status, query, sort]);
  const candidatePage = pageState.key === filterKey ? pageState.number : 1;
  const requestKey = JSON.stringify([filterKey, candidatePage]);
  const listPending = listLoading || loadedKey !== requestKey;
  function filterParams() {
    return new URLSearchParams({ ...(departmentId ? { department_id: departmentId } : {}), status, q: query });
  }
  async function refresh() {
    const version = ++requestVersion.current;
    setLoadError(''); setListLoading(true); setCheckedIds(new Set());
    const params = page === 'candidates' ? filterParams() : new URLSearchParams();
    params.set('page', page === 'candidates' ? candidatePage : 1);
    params.set('page_size', page === 'candidates' ? 100 : 5);
    params.set('sort', page === 'candidates' ? sort : 'recent');
    try {
      const [ds, result, totals] = await Promise.all([api('/departments'), api(`/candidates/page?${params}`), api('/summary')]);
      if (version !== requestVersion.current) return;
      setDepartments(ds); setCandidates(result.items); setSummary(totals); setResultTotal(result.total);
      setLoadedKey(requestKey);
      if (page === 'candidates' && result.page !== candidatePage) setPageState({ key: filterKey, number: result.page });
    } catch (err) { if (version === requestVersion.current) setLoadError(err.message); }
    finally { if (version === requestVersion.current) { setLoading(false); setListLoading(false); } }
  }
  useEffect(() => {
    setCheckedIds(new Set());
    const timer = setTimeout(refresh, 180);
    return () => { clearTimeout(timer); requestVersion.current++; };
  }, [requestKey]);
  async function confirmDeleteAllMatches() {
    const version = requestVersion.current;
    setSelectionLoading(true);
    try {
      const result = await api(`/candidates/selection?${filterParams()}`);
      if (version !== requestVersion.current) return;
      setDeleteTargets(result.ids.map(id => ({ id }))); setDeleteError(''); setModal('bulk-delete');
    } catch (err) { setToast(err.message); }
    finally { setSelectionLoading(false); }
  }
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 4000); return () => clearTimeout(timer); }, [toast]);
  function navigate(next) { if (driveBusy) { setToast('Wait for the Drive operation to finish, or stop the import.'); return; } setPage(next); setDepartmentId(''); setStatus(''); setQuery(''); }
  function openDepartment(id) { if (driveBusy) { setToast('Wait for the Drive operation to finish, or stop the import.'); return; } setPage('candidates'); setDepartmentId(String(id)); setQuery(''); setStatus(''); }
  async function saved(message) { setModal(null); setSelected(null); setToast(message); await refresh(); }
  async function remove() {
    setDeleting(true); setDeleteError('');
    try { await api(`/candidates/${selected.id}`, { method: 'DELETE' }); await saved('Candidate deleted'); }
    catch (err) { setDeleteError(err.message); }
    finally { setDeleting(false); }
  }
  async function removeSelected() {
    setDeleting(true); setDeleteError('');
    try {
      const result = await api('/candidates/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-HR-Request': 'bulk-delete' },
        body: JSON.stringify({ ids: deleteTargets.map(c => c.id) }),
      });
      setCheckedIds(new Set()); setDeleteTargets([]);
      await saved(`${result.deleted_count} candidates and their CVs deleted`);
    } catch (err) { setDeleteError(err.message); }
    finally { setDeleting(false); }
  }
  async function removeDepartment() {
    setDeleting(true); setDeleteError('');
    try {
      await api(`/departments/${departmentToDelete.id}`, {
        method: 'DELETE', headers: { 'X-HR-Request': 'delete-department' },
      });
      if (departmentId === String(departmentToDelete.id)) setDepartmentId('');
      setDepartmentToDelete(null);
      await saved('Department deleted');
    } catch (err) { setDeleteError(err.message); }
    finally { setDeleting(false); }
  }
  const selectedDepartment = departments.find(d => String(d.id) === departmentId);
  const filtered = listPending ? [] : candidates;
  const departmentResults = departments.filter(d => `${d.name} ${d.description}`.toLowerCase().includes(query.toLowerCase().trim()));
  const checkedCandidates = filtered.filter(c => checkedIds.has(c.id));
  const allChecked = filtered.length > 0 && checkedCandidates.length === filtered.length;
  function selectAll(checked) { setCheckedIds(new Set(checked ? filtered.map(c => c.id) : [])); }
  function selectCandidate(id, checked) {
    setCheckedIds(previous => { const next = new Set(previous); if (checked) next.add(id); else next.delete(id); return next; });
  }
  const countCVs = summary.cvs;
  const active = summary.active;
  const title = page === 'drive' ? 'Your Drive. Your talent workspace.' : page === 'overview' ? 'A little order. A lot of potential.' : page === 'departments' ? 'Great teams start here.' : selectedDepartment ? selectedDepartment.name : 'Meet your next great hire.';
  const table = <section className="panel candidates-panel"><div className="section-heading"><div><h2>{page === 'overview' ? 'Recent candidates' : 'Candidate directory'}<span className="count-pill">{page === 'overview' ? summary.total : resultTotal}</span></h2><p>{page === 'overview' ? 'Your latest connections, all in one place.' : 'The people behind the possibilities.'}</p></div>{page === 'overview' ? <button className="text-button" onClick={() => navigate('candidates')}>View all candidates<ArrowRight size={16}/></button> : <select aria-label="Sort candidates" className="sort-select" value={sort} onChange={e => setSort(e.target.value)}><option value="recent">Newest first</option><option value="name">Name A–Z</option></select>}</div>
    {page === 'candidates' && <div className="filters"><label className="search-input"><Search size={17}/><input aria-label="Search candidates" placeholder="Search name, role, or email…" value={query} onChange={e => setQuery(e.target.value)}/>{query && <button aria-label="Clear search" onClick={() => setQuery('')}><X size={15}/></button>}</label><select aria-label="Filter by department" value={departmentId} onChange={e => setDepartmentId(e.target.value)}><option value="">All departments</option>{departments.map(d => <option value={d.id} key={d.id}>{d.name}</option>)}</select><select aria-label="Filter by status" value={status} onChange={e => setStatus(e.target.value)}><option value="">All statuses</option>{statuses.map(s => <option key={s}>{s}</option>)}</select></div>}
    {page === 'candidates' && filtered.length > 0 && <div className="bulk-actions">
      <label><input type="checkbox" className="candidate-checkbox" aria-label="Select all candidates on this page" checked={allChecked} ref={node => { if (node) node.indeterminate = checkedCandidates.length > 0 && !allChecked; }} onChange={e => selectAll(e.target.checked)}/>Select all {filtered.length} on this page</label>
      <span>{checkedCandidates.length} selected</span>
      {resultTotal > filtered.length && <button className="text-button" disabled={selectionLoading} onClick={confirmDeleteAllMatches}>{selectionLoading ? 'Preparing…' : `Delete all ${resultTotal} matching candidates…`}</button>}
      <button className="button danger small" disabled={!checkedCandidates.length} onClick={() => { setDeleteTargets([...checkedCandidates]); setDeleteError(''); setModal('bulk-delete'); }}><Trash2 size={15}/>Delete selected</button>
    </div>}
    {listPending ? <div className="loading-state"><span className="spinner"/>Loading candidates…</div> : (page === 'overview' ? candidates : filtered).length ? <div className="table-wrap"><table><thead><tr>{page === 'candidates' && <th className="selection-cell"><span className="sr-only">Select candidate</span></th>}<th>Candidate</th><th>Department</th><th>Status</th><th title="Google Drive modification date at import">Date modified (Drive)</th><th>Added</th><th><span className="sr-only">Open profile</span></th></tr></thead><tbody>{(page === 'overview' ? candidates.slice(0, 5) : filtered).map(c => <tr key={c.id}>{page === 'candidates' && <td className="selection-cell"><input type="checkbox" className="candidate-checkbox" aria-label={`Select ${c.name}`} checked={checkedIds.has(c.id)} onChange={e => selectCandidate(c.id, e.target.checked)}/></td>}<td><button className="candidate-name" onClick={() => { setSelected(c); setModal('detail'); }}><span className={`avatar ${c.department_color}`}>{initials(c.name)}</span><span><strong>{c.name}</strong><small>{c.role}</small></span></button></td><td>{c.department_name}</td><td><span className={`status ${c.status.toLowerCase()}`}>{c.status}</span></td><td className="date-cell">{modifiedDate(c.drive_modified_time)}</td><td className="date-cell">{date(c.created_at)}</td><td><button className="icon-button" aria-label={`Open ${c.name}'s profile`} onClick={() => { setSelected(c); setModal('detail'); }}><ArrowUpRight size={18}/></button></td></tr>)}</tbody></table></div> : <div className="empty-state"><span className="empty-art"><Users size={28}/><span><Plus size={13}/></span></span><h3>{summary.total ? 'No candidates match these filters' : 'Your next great hire starts here'}</h3><p>{summary.total ? 'Try another name, department, or application status.' : 'Add your first candidate, upload their CV, and give them a place in your team’s story.'}</p>{summary.total ? <button className="button secondary" onClick={() => { setQuery(''); setDepartmentId(''); setStatus(''); }}>Clear filters</button> : <button className="button primary" onClick={() => { setSelected(null); setModal('candidate'); }}><Plus size={16}/>Add your first candidate</button>}</div>}
    {page === 'candidates' ? <Pagination page={candidatePage} total={resultTotal} onChange={number => setPageState({ key: filterKey, number })} disabled={listPending || selectionLoading} label="candidates"/> : <div className="table-footer"><span>Showing {candidates.length} of {summary.total} candidates</span><span><ShieldCheck size={14}/>Organized. Accessible. In one place.</span></div>}
  </section>;
  return <div className="app-shell">
    <aside className="sidebar"><a className="brand" href="#" onClick={e => { e.preventDefault(); navigate('overview'); }}><span className="brand-icon"><Users size={23}/></span>people<span>desk</span><span className="brand-dot">.</span></a><div className="workspace"><span className="workspace-avatar">W</span><div><strong>Your workspace</strong><small>Human resources</small></div><span className="workspace-indicator"/></div><small className="nav-label">WORKSPACE</small><nav aria-label="Main navigation">{[[ 'overview', LayoutDashboard, 'Overview' ], ['departments', Building2, 'Departments'], ['candidates', Users, 'All candidates'], ['drive', CloudDownload, 'Drive import']].map(([key, Icon, label]) => <button key={key} className={`nav-item ${page === key ? 'active' : ''}`} onClick={() => navigate(key)}><Icon size={19}/>{label}{key === 'candidates' && <span className="nav-count">{summary.total}</span>}</button>)}</nav><div className="sidebar-divider"/><div className="nav-label department-label">DEPARTMENTS<button aria-label="Add department" onClick={() => setModal('department')}><Plus size={16}/></button></div><nav className="department-nav" aria-label="Departments">{departments.map(d => <button key={d.id} className={departmentId === String(d.id) ? 'selected' : ''} onClick={() => openDepartment(d.id)}><span className={`department-dot ${d.color}`}/><span>{d.name}</span><small>{d.candidate_count}</small></button>)}</nav><div className="sidebar-bottom"><div className="sidebar-note"><span><FolderOpen size={19}/></span><strong>Good people. One place.</strong><p>A home for every CV and every new possibility.</p></div><div className="user-profile"><span className="user-avatar">HR</span><div><strong>HR workspace</strong><small>Local workspace</small></div><ShieldCheck size={17}/></div></div></aside>
    <div className="main-shell"><header className="topbar"><div className="breadcrumb">Workspace<span>/</span><strong>{page === 'drive' ? 'Drive import' : page === 'overview' ? 'Overview' : page === 'departments' ? 'Departments' : 'Candidates'}</strong></div><div className="topbar-right"><span className="today">{new Date().toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })}</span><span className="topbar-divider"/><span className="top-avatar">HR</span></div></header>
    <main><div className="page-heading"><div><div className="eyebrow"><span/>{page === 'drive' ? 'IMPORT FROM GOOGLE DRIVE' : page === 'overview' ? 'YOUR PEOPLE, AT A GLANCE' : page === 'departments' ? 'ROOM FOR EVERY TEAM' : 'YOUR TALENT WORKSPACE'}</div><h1>{title}</h1><p>{page === 'drive' ? 'Bring existing CVs into the right department, one folder at a time.' : page === 'overview' ? 'Keep your departments, candidates, and CVs beautifully organized.' : page === 'departments' ? 'Explore your departments and the people who could be part of them.' : selectedDepartment ? selectedDepartment.description : 'Find, review, and keep track of every candidate.'}</p></div>{page !== 'drive' && <button className="button primary" disabled={loading || !!loadError} onClick={() => { setSelected(null); setModal(page === 'departments' ? 'department' : 'candidate'); }}><Plus size={18}/>{page === 'departments' ? 'New department' : 'Add candidate'}</button>}</div>
      {loadError ? <div className="error-banner" role="alert"><div><h3>We couldn’t load your workspace</h3><p>{loadError}</p></div><button className="button secondary" onClick={refresh}>Try again</button></div> : loading ? <div className="loading-state"><span className="spinner"/>Loading your workspace…</div> : <>
      <div hidden={page !== 'drive'}><DriveImport active={page === 'drive'} departments={departments} onImported={refresh} onBusyChange={setDriveBusy}/></div>
      {page === 'overview' && <><div className="stats-grid">{[[Users, 'Total candidates', summary.total, 'People in your talent pool', 'green'], [Building2, 'Departments', departments.length, 'Teams with room to grow', 'purple'], [FileText, 'CVs saved', countCVs, 'Every résumé, within reach', 'orange'], [Sparkles, 'In the pipeline', active, 'Candidates under consideration', 'blue']].map(([Icon, label, count, note, color]) => <div className="stat-card" key={label}><div><span>{label}</span><span className={`stat-icon ${color}`}><Icon size={18}/></span></div><strong>{count.toString().padStart(2, '0')}</strong><small>{note}</small></div>)}</div><div className="welcome-banner"><div className="banner-pattern" aria-hidden="true"><div/><div/><div/></div><span className="banner-icon"><FolderOpen size={28}/></span><div><h2>A place for every possibility.</h2><p>Browse by team. Find the right person. Keep their story close.</p></div><button onClick={() => navigate('departments')}>Explore departments<ArrowRight size={17}/></button></div></>}
      {(page === 'overview' || page === 'departments') && <section className="departments-section"><div className="section-heading"><div><h2>Departments<span className="count-pill">{departments.length}</span></h2><p>A dedicated space for every team’s talent.</p></div>{page === 'overview' ? <button className="text-button" onClick={() => setModal('department')}><Plus size={16}/>New department</button> : <label className="search-input department-search"><Search size={17}/><input aria-label="Search departments" placeholder="Find a department…" value={query} onChange={e => setQuery(e.target.value)}/></label>}</div><div className="department-grid">{(page === 'overview' ? departments : departmentResults).map(d => { const Icon = departmentIcons[d.name] || Building2; return <div className="department-card-container" key={d.id}><button className="department-card" onClick={() => openDepartment(d.id)}><div className="department-card-top"><span className={`department-icon ${d.color}`}><Icon size={23}/></span></div><h3>{d.name}</h3><p>{d.description || 'A new home for your next great team'}</p><div className="department-card-bottom"><span><Users size={14}/><strong>{d.candidate_count}</strong> candidates</span><span><FileText size={14}/>{d.cv_count} CVs</span></div></button><button className="icon-button department-delete" title={`Delete ${d.name}`} aria-label={`Delete ${d.name} department`} onClick={() => { setDepartmentToDelete(d); setDeleteError(''); setModal('delete-department'); }}><Trash2 size={17}/></button></div>; })}{page === 'departments' && !query && <button className="department-card add-department" onClick={() => setModal('department')}><span><Plus size={24}/></span><h3>Make room for a new team</h3><p>Create a department</p></button>}</div>{page === 'departments' && query && !departmentResults.length && <div className="empty-state"><Search size={26}/><h3>No departments found</h3><p>Try a different department name.</p></div>}</section>}
      {(page === 'overview' || page === 'candidates') && table}
      <footer className="page-footer"><span>Made for people. Built for possibility.</span><span>PeopleDesk <span className="footer-dot">●</span> HR workspace</span></footer>
      </>}
    </main></div>
    {modal === 'candidate' && <CandidateForm candidate={selected} departments={departments} departmentId={departmentId} onClose={() => setModal(null)} onSaved={saved}/>}
    {modal === 'department' && <DepartmentForm onClose={() => setModal(null)} onSaved={saved}/>}
    {modal === 'detail' && selected && <CandidateDetail candidate={selected} onClose={() => setModal(null)} onEdit={() => setModal('candidate')} onDelete={() => { setDeleteError(''); setModal('delete'); }}/>}
    {modal === 'delete' && <Modal title="Delete this candidate?" description={`${selected.name}’s profile and uploaded CV will be permanently removed.`} onClose={() => !deleting && setModal('detail')}>{deleteError && <p className="form-error" role="alert">{deleteError}</p>}<div className="modal-actions"><button className="button secondary" disabled={deleting} onClick={() => setModal('detail')}>Keep candidate</button><button className="button danger" disabled={deleting} onClick={remove}>{deleting ? 'Deleting…' : 'Delete candidate'}</button></div></Modal>}
    {modal === 'bulk-delete' && <Modal title={`Delete ${deleteTargets.length} selected candidates?`} description="Their profiles, saved CV files, and import records will be permanently deleted from this database. This cannot be undone. Original Google Drive files will not be deleted." onClose={() => !deleting && setModal(null)}>
      <div className="bulk-delete-summary"><strong>{deleteTargets.length} candidates selected</strong><p>{deleteTargets.slice(0, 5).map(c => c.name || `Candidate #${c.id}`).join(', ')}{deleteTargets.length > 5 ? ` and ${deleteTargets.length - 5} more` : ''}</p></div>
      {deleteError && <p className="form-error" role="alert">{deleteError}</p>}
      <div className="modal-actions"><button autoFocus className="button secondary" disabled={deleting} onClick={() => setModal(null)}>Cancel</button><button className="button danger" disabled={deleting || !deleteTargets.length} onClick={removeSelected}>{deleting ? 'Deleting…' : `Permanently delete ${deleteTargets.length}`}</button></div>
    </Modal>}
    {modal === 'delete-department' && departmentToDelete && <Modal title={`Delete ${departmentToDelete.name}?`} description={departmentToDelete.candidate_count ? `This department has ${departmentToDelete.candidate_count} candidates. Move or delete them first. Their CVs will not be deleted by this action.` : 'This department and its Drive folder links will be permanently removed from the database. Original Google Drive folders and files will stay safe.'} onClose={() => !deleting && setModal(null)}>
      {deleteError && <p className="form-error" role="alert">{deleteError}</p>}
      <div className="modal-actions"><button autoFocus className="button secondary" disabled={deleting} onClick={() => setModal(null)}>Cancel</button>{departmentToDelete.candidate_count ? <button className="button primary" onClick={() => { setModal(null); openDepartment(departmentToDelete.id); }}>View candidates</button> : <button className="button danger" disabled={deleting} onClick={removeDepartment}>{deleting ? 'Deleting…' : 'Delete department'}</button>}</div>
    </Modal>}
    {toast && <div className="toast" role="status"><Check size={17}/>{toast}<button aria-label="Dismiss notification" onClick={() => setToast('')}><X size={15}/></button></div>}
  </div>;
}

createRoot(document.getElementById('root')).render(<App/>);

