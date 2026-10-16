"""Local HR workspace. Run from project root: python -m uvicorn backend.main:app."""

import io
import os
import re
import sqlite3
import zipfile
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path
from typing import Annotated
from urllib.parse import quote

from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("HR_DATA_DIR", str(ROOT / "backend" / "data")))
UPLOADS = DATA / "uploads"
STATUSES = ("New", "Screening", "Interview", "Offer", "Hired", "Rejected")
MAX_FILE_SIZE = 10 * 1024 * 1024
DEFAULT_DEPARTMENTS = [
    ("AI", "AI models, automation, and intelligent solutions", "blue"),
    ("SEO", "Search visibility, rankings, and organic growth", "cyan"),
    ("CONTENT WRITING", "Content, copywriting, and brand storytelling", "purple"),
    ("CREATIVE", "Visual design, video, and creative production", "violet"),
    ("MARKETING", "Campaigns, brand strategy, and audience growth", "indigo"),
    ("SHOPIFY", "E-commerce stores, themes, and integrations", "sky"),
    ("FULL STACK", "Frontend, backend, and complete web applications", "blue"),
]


@contextmanager
def db():
    conn = sqlite3.connect(DATA / "hr.sqlite3", timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        with conn:
            yield conn
    finally:
        conn.close()


def initialize():
    DATA.mkdir(parents=True, exist_ok=True)
    with db() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS departments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL COLLATE NOCASE UNIQUE,
                description TEXT NOT NULL DEFAULT '',
                color TEXT NOT NULL DEFAULT 'blue'
            );
            CREATE TABLE IF NOT EXISTS candidates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                email TEXT NOT NULL,
                phone TEXT NOT NULL DEFAULT '',
                role TEXT NOT NULL,
                department_id INTEGER NOT NULL REFERENCES departments(id),
                status TEXT NOT NULL DEFAULT 'New',
                experience REAL NOT NULL DEFAULT 0,
                notes TEXT NOT NULL DEFAULT '',
                cv_name TEXT,
                cv_path TEXT,
                cv_type TEXT,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            );
            CREATE INDEX IF NOT EXISTS idx_candidates_department ON candidates(department_id);
            CREATE INDEX IF NOT EXISTS idx_candidates_recent ON candidates(created_at DESC, id DESC);
            CREATE INDEX IF NOT EXISTS idx_candidates_department_recent ON candidates(department_id, created_at DESC, id DESC);
            CREATE INDEX IF NOT EXISTS idx_candidates_name ON candidates(name COLLATE NOCASE, id);
            CREATE TABLE IF NOT EXISTS candidate_cvs (
                candidate_id INTEGER PRIMARY KEY REFERENCES candidates(id) ON DELETE CASCADE,
                content BLOB NOT NULL
            );
            CREATE TABLE IF NOT EXISTS schema_migrations (
                name TEXT PRIMARY KEY
            );
            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY, value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS drive_folders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                folder_id TEXT NOT NULL UNIQUE,
                folder_name TEXT NOT NULL,
                resource_key TEXT NOT NULL DEFAULT '',
                department_id INTEGER NOT NULL REFERENCES departments(id)
            );
            CREATE TABLE IF NOT EXISTS drive_imports (
                file_id TEXT PRIMARY KEY,
                candidate_id INTEGER NOT NULL UNIQUE REFERENCES candidates(id) ON DELETE CASCADE,
                folder_id TEXT NOT NULL,
                imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            );
        """)
        if 'modified_time' not in {row['name'] for row in conn.execute('PRAGMA table_info(drive_imports)')}:
            conn.execute('ALTER TABLE drive_imports ADD COLUMN modified_time TEXT')
        if not conn.execute("SELECT 1 FROM schema_migrations WHERE name = 'team_departments_v1'").fetchone():
            # Replace empty starter departments; retain any department with candidates.
            conn.execute("""
                DELETE FROM departments
                WHERE name IN ('Engineering', 'Design', 'Sales', 'Human Resources', 'Finance')
                AND NOT EXISTS (SELECT 1 FROM candidates WHERE department_id = departments.id)
            """)
            conn.executemany("""
                INSERT INTO departments(name, description, color) VALUES (?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET
                    name = excluded.name, description = excluded.description, color = excluded.color
            """, DEFAULT_DEPARTMENTS)
            conn.execute("INSERT INTO schema_migrations(name) VALUES ('team_departments_v1')")
        # Import legacy disk uploads atomically. Existing files are retained as backups.
        legacy_root = UPLOADS.resolve()
        for record in conn.execute("""
            SELECT id, cv_path FROM candidates WHERE cv_path IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM candidate_cvs WHERE candidate_id = candidates.id)
        """).fetchall():
            path = (legacy_root / record['cv_path']).resolve()
            if not path.is_relative_to(legacy_root) or not path.is_file():
                raise RuntimeError(f"Cannot migrate CV for candidate {record['id']}: restore the missing file in the legacy uploads folder and restart.")
            content = path.read_bytes()
            if not content:
                raise RuntimeError(f"Cannot migrate empty CV for candidate {record['id']}.")
            conn.execute("INSERT INTO candidate_cvs(candidate_id, content) VALUES (?, ?)", (record['id'], content))
        conn.execute("""
            UPDATE candidates SET cv_path = NULL WHERE cv_path IS NOT NULL
            AND EXISTS (SELECT 1 FROM candidate_cvs WHERE candidate_id = candidates.id)
        """)


@asynccontextmanager
async def lifespan(app):
    initialize()
    yield


app = FastAPI(title="PeopleDesk API", lifespan=lifespan)


class DepartmentInput(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=200)


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/departments")
def departments():
    with db() as conn:
        return [dict(row) for row in conn.execute("""
            SELECT d.*, COUNT(c.id) AS candidate_count,
                COUNT(cv.candidate_id) AS cv_count
            FROM departments d LEFT JOIN candidates c ON c.department_id = d.id
            LEFT JOIN candidate_cvs cv ON cv.candidate_id = c.id
            GROUP BY d.id ORDER BY CASE d.name
                WHEN 'AI' THEN 0 WHEN 'SEO' THEN 1 WHEN 'CONTENT WRITING' THEN 2
                WHEN 'CREATIVE' THEN 3 WHEN 'MARKETING' THEN 4 WHEN 'SHOPIFY' THEN 5
                WHEN 'FULL STACK' THEN 6 ELSE 7 END, d.id
        """)]


@app.post("/api/departments", status_code=201)
def create_department(data: DepartmentInput):
    name = data.name.strip()
    if not name:
        raise HTTPException(422, "Please enter a department name.")
    try:
        with db() as conn:
            cursor = conn.execute("INSERT INTO departments(name, description, color) VALUES (?, ?, 'blue')", (name, data.description.strip()))
            return dict(conn.execute("SELECT * FROM departments WHERE id = ?", (cursor.lastrowid,)).fetchone())
    except sqlite3.IntegrityError:
        raise HTTPException(409, "A department with this name already exists.")


@app.delete('/api/departments/{department_id}', status_code=204)
def delete_department(department_id: int, request: Request):
    if request.headers.get('x-hr-request') != 'delete-department':
        raise HTTPException(403, 'Please delete departments from your HR workspace.')
    with db() as conn:
        conn.execute('BEGIN IMMEDIATE')
        if not conn.execute('SELECT 1 FROM departments WHERE id = ?', (department_id,)).fetchone():
            raise HTTPException(404, 'Department not found.')
        if conn.execute('SELECT 1 FROM candidates WHERE department_id = ?', (department_id,)).fetchone():
            raise HTTPException(409, 'This department still has candidates. Move or delete them first, then try again.')
        conn.execute('DELETE FROM drive_folders WHERE department_id = ?', (department_id,))
        conn.execute('DELETE FROM departments WHERE id = ?', (department_id,))


def candidate_record(candidate_id):
    with db() as conn:
        row = conn.execute("""
            SELECT c.*, d.name AS department_name, d.color AS department_color,
                i.modified_time AS drive_modified_time
            FROM candidates c JOIN departments d ON d.id = c.department_id
            LEFT JOIN drive_imports i ON i.candidate_id = c.id WHERE c.id = ?
        """, (candidate_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "Candidate not found.")
    return dict(row)


def public_candidate(record):
    record = dict(record)
    record.pop("cv_path", None)
    return record


@app.get("/api/candidates")
def candidates():
    with db() as conn:
        return [public_candidate(row) for row in conn.execute("""
            SELECT c.*, d.name AS department_name, d.color AS department_color,
                i.modified_time AS drive_modified_time
            FROM candidates c JOIN departments d ON d.id = c.department_id
            LEFT JOIN drive_imports i ON i.candidate_id = c.id
            ORDER BY c.created_at DESC, c.id DESC
        """)]


def candidate_filter(department_id, status, q):
    clauses, values = [], []
    if department_id is not None:
        clauses.append('c.department_id = ?')
        values.append(department_id)
    if status:
        clauses.append('c.status = ?')
        values.append(status)
    if q.strip():
        clauses.append("instr(lower(c.name || ' ' || c.email || ' ' || c.role || ' ' || d.name), lower(?)) > 0")
        values.append(q.strip())
    return (' WHERE ' + ' AND '.join(clauses) if clauses else ''), values


@app.get('/api/candidates/page')
def candidates_page(page: int = Query(1, ge=1), page_size: int = Query(100, ge=1, le=100),
                    department_id: int | None = Query(None, ge=1), status: str = '',
                    q: str = Query('', max_length=300), sort: str = Query('recent', pattern='^(recent|name)$')):
    where, values = candidate_filter(department_id, status, q)
    joins = ' FROM candidates c JOIN departments d ON d.id = c.department_id'
    order = 'c.name COLLATE NOCASE, c.id' if sort == 'name' else 'c.created_at DESC, c.id DESC'
    with db() as conn:
        conn.execute('BEGIN')
        total = conn.execute('SELECT COUNT(*)' + joins + where, values).fetchone()[0]
        pages = max(1, (total + page_size - 1) // page_size)
        page = min(page, pages)
        items = [public_candidate(row) for row in conn.execute(
            'SELECT c.*, d.name AS department_name, d.color AS department_color, i.modified_time AS drive_modified_time'
            + joins + ' LEFT JOIN drive_imports i ON i.candidate_id = c.id' + where
            + f' ORDER BY {order} LIMIT ? OFFSET ?', [*values, page_size, (page - 1) * page_size])]
    return {'items': items, 'total': total, 'page': page, 'page_size': page_size, 'pages': pages}


@app.get('/api/candidates/selection')
def candidate_selection(department_id: int | None = Query(None, ge=1), status: str = '', q: str = Query('', max_length=300)):
    where, values = candidate_filter(department_id, status, q)
    with db() as conn:
        return {'ids': [row[0] for row in conn.execute(
            'SELECT c.id FROM candidates c JOIN departments d ON d.id = c.department_id' + where + ' ORDER BY c.id', values)]}


@app.get('/api/summary')
def summary():
    with db() as conn:
        return dict(conn.execute("""SELECT COUNT(*) AS total,
            COALESCE(SUM(status NOT IN ('Hired', 'Rejected')), 0) AS active,
            (SELECT COUNT(*) FROM candidate_cvs) AS cvs FROM candidates""").fetchone())


async def save_cv(cv):
    if not cv or not cv.filename:
        return None
    name = cv.filename.replace("\\", "/").split("/")[-1][:180]
    extension = Path(name).suffix.lower()
    if extension not in (".pdf", ".docx"):
        raise HTTPException(422, "CVs must be PDF or DOCX files.")
    try:
        content = bytearray()
        while chunk := await cv.read(1024 * 1024):
            if len(content) + len(chunk) > MAX_FILE_SIZE:
                raise HTTPException(413, "The CV must be smaller than 10 MB.")
            content.extend(chunk)
        if not content:
            raise HTTPException(422, "The uploaded file is empty.")
        if extension == ".pdf":
            if not content.startswith(b"%PDF-"):
                raise HTTPException(422, "This file is not a valid PDF.")
        else:
            try:
                with zipfile.ZipFile(io.BytesIO(content)) as archive:
                    if not {"[Content_Types].xml", "word/document.xml"}.issubset(archive.namelist()) or any(n.lower().endswith("vbaproject.bin") for n in archive.namelist()):
                        raise ValueError("Invalid DOCX")
            except (zipfile.BadZipFile, ValueError):
                raise HTTPException(422, "This file is not a valid DOCX.")
        mime = "application/pdf" if extension == ".pdf" else "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        return {"cv_name": name, "content": bytes(content), "cv_type": mime}
    finally:
        await cv.close()


@app.post("/api/candidates", status_code=201)
@app.put("/api/candidates/{candidate_id}")
async def save_candidate(
    candidate_id: int | None = None,
    name: str = Form(..., max_length=120),
    email: str = Form('', max_length=254),
    role: str = Form(..., max_length=120),
    department_id: int = Form(...),
    phone: str = Form("", max_length=40),
    status: str = Form("New"),
    experience: float = Form(0, ge=0, le=60),
    notes: str = Form("", max_length=5000),
    cv: UploadFile | None = File(None),
):
    name, email, role = name.strip(), email.strip(), role.strip()
    if not name or not role or (email and not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email)):
        raise HTTPException(422, "Enter a name and role. Email may be blank, but must be valid when provided.")
    if status not in STATUSES:
        raise HTTPException(422, "Invalid candidate status.")
    previous = candidate_record(candidate_id) if candidate_id is not None else None
    with db() as conn:
        if not conn.execute("SELECT id FROM departments WHERE id = ?", (department_id,)).fetchone():
            raise HTTPException(422, "Choose an existing department.")
    upload = await save_cv(cv)
    values = dict(name=name, email=email, role=role, department_id=department_id,
                  phone=phone.strip(), status=status, experience=experience, notes=notes.strip())
    if upload:
        values.update(cv_name=upload['cv_name'], cv_type=upload['cv_type'])
    with db() as conn:
        if previous:
            conn.execute("UPDATE candidates SET " + ", ".join(f"{key} = ?" for key in values) + " WHERE id = ?", (*values.values(), candidate_id))
        else:
            cursor = conn.execute("INSERT INTO candidates (" + ", ".join(values) + ") VALUES (" + ", ".join("?" for _ in values) + ")", tuple(values.values()))
            candidate_id = cursor.lastrowid
        if upload:
            conn.execute("""
                INSERT INTO candidate_cvs(candidate_id, content) VALUES (?, ?)
                ON CONFLICT(candidate_id) DO UPDATE SET content = excluded.content
            """, (candidate_id, upload['content']))
    return public_candidate(candidate_record(candidate_id))


@app.get("/api/candidates/{candidate_id}/cv")
def read_cv(candidate_id: int, download: bool = False):
    record = candidate_record(candidate_id)
    with db() as conn:
        cv = conn.execute("SELECT content FROM candidate_cvs WHERE candidate_id = ?", (candidate_id,)).fetchone()
    if cv is None:
        raise HTTPException(404, "No CV has been uploaded for this candidate.")
    disposition = "attachment" if download or record["cv_type"] != "application/pdf" else "inline"
    return Response(content=cv['content'], media_type=record['cv_type'], headers={
        "Content-Disposition": f"{disposition}; filename*=utf-8''{quote(record['cv_name'], safe='')}",
        "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store",
    })


@app.delete("/api/candidates/{candidate_id}", status_code=204)
def delete_candidate(candidate_id: int):
    candidate_record(candidate_id)
    with db() as conn:
        conn.execute("DELETE FROM candidates WHERE id = ?", (candidate_id,))


class BulkDeleteInput(BaseModel):
    ids: list[Annotated[int, Field(strict=True, gt=0)]] = Field(min_length=1, max_length=100000)


@app.post('/api/candidates/bulk-delete')
def delete_candidates(data: BulkDeleteInput, request: Request):
    if request.headers.get('x-hr-request') != 'bulk-delete':
        raise HTTPException(403, 'Please delete candidates from your HR workspace.')
    ids = list(dict.fromkeys(data.ids))
    with db() as conn:
        conn.execute('BEGIN IMMEDIATE')
        deleted = 0
        for offset in range(0, len(ids), 400):
            batch = ids[offset:offset + 400]
            placeholders = ','.join('?' for _ in batch)
            deleted += conn.execute(f'DELETE FROM candidates WHERE id IN ({placeholders})', batch).rowcount
        if deleted != len(ids):
            # Roll back the entire batch if the confirmed selection is stale.
            raise HTTPException(409, 'Some selected candidates no longer exist. Refresh the list and select again.')
    # Foreign keys cascade to CV BLOBs and Drive import records, not Drive files.
    return {'deleted_count': deleted}


from backend.drive import create_router

app.include_router(create_router(db, save_cv))

if (ROOT / "dist").exists():
    app.mount("/", StaticFiles(directory=ROOT / "dist", html=True), name="frontend")
