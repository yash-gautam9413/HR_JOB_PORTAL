"""Local persistence for user-selected Drive imports.

Google authorization and Drive downloads run in the browser. OAuth tokens never
enter the database or these endpoints; only the selected CV and its metadata do.
"""
import re
from datetime import timezone

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from pydantic import AwareDatetime, BaseModel, Field

DRIVE_ID = r"^[A-Za-z0-9_-]{1,200}$"


class DriveSettings(BaseModel):
    client_id: str = Field(pattern=r"^[A-Za-z0-9-]{5,200}\.apps\.googleusercontent\.com$")


class FolderMapping(BaseModel):
    folder_id: str = Field(pattern=DRIVE_ID)
    folder_name: str = Field(min_length=1, max_length=200)
    resource_key: str = Field(default='', pattern=r'^[A-Za-z0-9_-]{0,200}$')
    department_id: int


def require_app_request(request: Request):
    # A custom header cannot be sent by a cross-origin HTML form; no CORS is enabled.
    if request.method != 'GET' and request.headers.get('x-hr-request') != 'drive-import':
        raise HTTPException(403, 'Please use the Drive import page in your HR workspace.')


def create_router(db, save_cv):
    router = APIRouter(prefix='/api/drive', dependencies=[Depends(require_app_request)])

    @router.get('/settings')
    def settings():
        with db() as conn:
            row = conn.execute("SELECT value FROM app_settings WHERE key = 'google_client_id'").fetchone()
        return {'client_id': row['value'] if row else ''}

    @router.put('/settings')
    def update_settings(data: DriveSettings):
        with db() as conn:
            conn.execute("""INSERT INTO app_settings(key, value) VALUES ('google_client_id', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value""", (data.client_id,))
        return {'client_id': data.client_id}

    @router.get('/mappings')
    def mappings():
        with db() as conn:
            return [dict(row) for row in conn.execute("""
                SELECT m.*, d.name AS department_name,
                    (SELECT COUNT(*) FROM drive_imports i WHERE i.folder_id = m.folder_id) AS imported_count
                FROM drive_folders m JOIN departments d ON d.id = m.department_id ORDER BY m.id
            """)]

    @router.post('/mappings')
    def save_mapping(data: FolderMapping):
        if not data.folder_name.strip():
            raise HTTPException(422, 'Enter a folder name.')
        with db() as conn:
            if not conn.execute('SELECT 1 FROM departments WHERE id = ?', (data.department_id,)).fetchone():
                raise HTTPException(422, 'Choose an existing department.')
            conn.execute("""
                INSERT INTO drive_folders(folder_id, folder_name, resource_key, department_id) VALUES (?, ?, ?, ?)
                ON CONFLICT(folder_id) DO UPDATE SET folder_name = excluded.folder_name,
                    resource_key = excluded.resource_key, department_id = excluded.department_id
            """, (data.folder_id, data.folder_name.strip(), data.resource_key, data.department_id))
            return dict(conn.execute('SELECT * FROM drive_folders WHERE folder_id = ?', (data.folder_id,)).fetchone())

    @router.delete('/mappings/{mapping_id}', status_code=204)
    def remove_mapping(mapping_id: int):
        with db() as conn:
            if not conn.execute('DELETE FROM drive_folders WHERE id = ?', (mapping_id,)).rowcount:
                raise HTTPException(404, 'Folder mapping not found.')

    @router.get('/imports')
    def imported_files():
        with db() as conn:
            return [dict(row) for row in conn.execute("""
                SELECT i.file_id, i.candidate_id, i.folder_id, i.imported_at, i.modified_time, c.name, c.cv_name,
                    d.name AS department_name FROM drive_imports i
                JOIN candidates c ON c.id = i.candidate_id
                JOIN departments d ON d.id = c.department_id
                ORDER BY i.imported_at DESC, i.candidate_id DESC
            """)]

    @router.post('/import')
    async def import_candidate(
        mapping_id: int = Form(...),
        file_id: str = Form(..., pattern=DRIVE_ID),
        name: str = Form(..., max_length=120),
        email: str = Form('', max_length=254),
        role: str = Form('', max_length=120),
        modified_time: AwareDatetime | None = Form(None),
        cv: UploadFile = File(...),
    ):
        name, email, role = name.strip(), email.strip(), role.strip()
        if not name:
            raise HTTPException(422, 'Review the candidate name before importing.')
        if email and not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', email):
            raise HTTPException(422, 'Enter a valid email or leave it blank.')
        with db() as conn:
            existing = conn.execute('SELECT candidate_id FROM drive_imports WHERE file_id = ?', (file_id,)).fetchone()
            if existing:
                await cv.close()
                return {'status': 'skipped', 'candidate_id': existing['candidate_id']}
            if not conn.execute('SELECT 1 FROM drive_folders WHERE id = ?', (mapping_id,)).fetchone():
                raise HTTPException(404, 'Folder mapping no longer exists. Select a folder again.')
        upload = await save_cv(cv)
        if upload is None:
            raise HTTPException(422, 'A CV file is required.')
        with db() as conn:
            # Lock before rechecking duplicate IDs, so simultaneous retries cannot duplicate a candidate.
            conn.execute('BEGIN IMMEDIATE')
            existing = conn.execute('SELECT candidate_id FROM drive_imports WHERE file_id = ?', (file_id,)).fetchone()
            if existing:
                return {'status': 'skipped', 'candidate_id': existing['candidate_id']}
            mapping = conn.execute('SELECT * FROM drive_folders WHERE id = ?', (mapping_id,)).fetchone()
            if not mapping:
                raise HTTPException(404, 'Folder mapping no longer exists. Select a folder again.')
            cursor = conn.execute("""
                INSERT INTO candidates(name, email, role, department_id, cv_name, cv_type)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (name, email, role or 'Not specified', mapping['department_id'], upload['cv_name'], upload['cv_type']))
            candidate_id = cursor.lastrowid
            conn.execute('INSERT INTO candidate_cvs(candidate_id, content) VALUES (?, ?)', (candidate_id, upload['content']))
            conn.execute('INSERT INTO drive_imports(file_id, candidate_id, folder_id, modified_time) VALUES (?, ?, ?, ?)',
                         (file_id, candidate_id, mapping['folder_id'],
                          modified_time.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z') if modified_time else None))
        return {'status': 'imported', 'candidate_id': candidate_id}

    @router.get('/history')
    def history(page: int = Query(1, ge=1)):
        with db() as conn:
            conn.execute('BEGIN')
            total = conn.execute('SELECT COUNT(*) FROM drive_imports').fetchone()[0]
            page = min(page, max(1, (total + 99) // 100))
            items = [dict(row) for row in conn.execute("""
                SELECT i.file_id, i.candidate_id, i.imported_at, i.modified_time, c.name, c.cv_name,
                    d.name AS department_name FROM drive_imports i
                JOIN candidates c ON c.id = i.candidate_id JOIN departments d ON d.id = c.department_id
                ORDER BY i.imported_at DESC, i.candidate_id DESC LIMIT 100 OFFSET ?
            """, ((page - 1) * 100,))]
        return {'items': items, 'total': total, 'page': page}

    @router.post('/check-imported')
    def check_imported(file_ids: list[str]):
        if len(file_ids) > 1000 or any(not re.fullmatch(DRIVE_ID, file_id) for file_id in file_ids):
            raise HTTPException(422, 'Check up to 1000 valid file IDs at a time.')
        found = []
        with db() as conn:
            for offset in range(0, len(file_ids), 400):
                batch = file_ids[offset:offset + 400]
                placeholders = ','.join('?' for _ in batch)
                found.extend(row[0] for row in conn.execute(f'SELECT file_id FROM drive_imports WHERE file_id IN ({placeholders})', batch))
        return {'ids': found}

    return router
