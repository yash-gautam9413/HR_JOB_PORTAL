"""API integration tests use a temporary database, never the workspace data."""
import io
import sqlite3
import tempfile
import unittest
import zipfile
from pathlib import Path

from fastapi.testclient import TestClient

from backend import main


class HRWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="peopledesk-test-")
        self.original_data, self.original_uploads = main.DATA, main.UPLOADS
        main.DATA = Path(self.temp.name)
        main.UPLOADS = main.DATA / "uploads"
        self.client_context = TestClient(main.app)
        self.client = self.client_context.__enter__()
        self.department = self.client.get("/api/departments").json()[0]["id"]
        self.details = {"name": "Test Candidate", "email": "candidate@example.com", "role": "Developer", "department_id": str(self.department), "experience": "3", "status": "New"}

    def tearDown(self):
        self.client_context.__exit__(None, None, None)
        main.DATA, main.UPLOADS = self.original_data, self.original_uploads
        self.temp.cleanup()

    def create(self, file=None):
        return self.client.post("/api/candidates", data=self.details, files={"cv": file} if file else None)

    def assert_no_upload_files(self):
        self.assertFalse(main.UPLOADS.exists(), 'New CV uploads must not create an uploads folder')

    def test_department_creation_and_case_insensitive_duplicates(self):
        response = self.client.post("/api/departments", json={"name": "  Operations  ", "description": "Our operations team"})
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["name"], "Operations")
        self.assertEqual(self.client.post("/api/departments", json={"name": "operations"}).status_code, 409)
        self.assertEqual(self.client.post("/api/departments", json={"name": "  "}).status_code, 422)

    def test_candidate_cv_edit_view_download_and_delete(self):
        original = b"%PDF-1.4\nTest CV bytes\n%%EOF"
        response = self.create(("resume.pdf", original, "application/pdf"))
        self.assertEqual(response.status_code, 201, response.text)
        record = response.json()
        candidate_id = record["id"]
        self.assertNotIn("cv_path", record)
        self.assertNotIn("content", record)
        with main.db() as conn:
            stored = conn.execute("SELECT content, typeof(content) AS storage_type FROM candidate_cvs WHERE candidate_id = ?", (candidate_id,)).fetchone()
            self.assertEqual(stored['content'], original)
            self.assertEqual(stored['storage_type'], 'blob')
        self.assertEqual(self.client.get("/api/candidates").json()[0]["name"], self.details["name"])
        department = self.client.get("/api/departments").json()[0]
        self.assertEqual((department["candidate_count"], department["cv_count"]), (1, 1))
        view = self.client.get(f"/api/candidates/{candidate_id}/cv")
        self.assertEqual(view.content, original)
        self.assertIn("inline", view.headers["content-disposition"])
        download = self.client.get(f"/api/candidates/{candidate_id}/cv?download=true")
        self.assertIn("attachment", download.headers["content-disposition"])
        updated = {**self.details, "status": "Interview", "notes": "Schedule next round"}
        edit = self.client.put(f"/api/candidates/{candidate_id}", data=updated)
        self.assertEqual(edit.status_code, 200, edit.text)
        self.assertEqual(edit.json()["cv_name"], "resume.pdf")
        self.assertEqual(edit.json()["status"], "Interview")
        self.assertEqual(self.client.get(f"/api/candidates/{candidate_id}/cv").content, original)
        self.assertEqual(self.client.delete(f"/api/candidates/{candidate_id}").status_code, 204)
        self.assertEqual(self.client.get(f"/api/candidates/{candidate_id}/cv").status_code, 404)
        with main.db() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM candidate_cvs").fetchone()[0], 0)
        self.assert_no_upload_files()

    def test_replacing_cv_updates_database_blob(self):
        candidate_id = self.create(("old.pdf", b"%PDF-1.4 old", "application/pdf")).json()["id"]
        response = self.client.put(f"/api/candidates/{candidate_id}", data=self.details, files={"cv": ("new.pdf", b"%PDF-1.4 new", "application/pdf")})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["cv_name"], "new.pdf")
        with main.db() as conn:
            rows = conn.execute("SELECT content FROM candidate_cvs").fetchall()
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]['content'], b'%PDF-1.4 new')
        self.assert_no_upload_files()

    def test_invalid_files_leave_no_records_or_files(self):
        for file in [("fake.pdf", b"not a PDF", "application/pdf"), ("fake.docx", b"not a DOCX", "application/octet-stream"), ("script.html", b"<script></script>", "text/html"), ("empty.pdf", b"", "application/pdf")]:
            with self.subTest(filename=file[0]):
                self.assertEqual(self.create(file).status_code, 422)
        self.assertEqual(self.client.get("/api/candidates").json(), [])
        self.assert_no_upload_files()

    def test_oversized_cv_is_rejected_and_cleaned(self):
        response = self.create(("large.pdf", b"%PDF-" + b"x" * main.MAX_FILE_SIZE, "application/pdf"))
        self.assertEqual(response.status_code, 413)
        self.assert_no_upload_files()

    def test_docx_is_downloadable(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("[Content_Types].xml", "<Types/>")
            archive.writestr("word/document.xml", "<document/>")
        response = self.create(("resume.docx", buffer.getvalue(), "application/octet-stream"))
        self.assertEqual(response.status_code, 201)
        view = self.client.get(f"/api/candidates/{response.json()['id']}/cv")
        self.assertIn("attachment", view.headers["content-disposition"])

    def test_invalid_candidate_fields(self):
        for field, value in [("email", "bad-email"), ("name", " "), ("role", " "), ("department_id", "9999"), ("status", "Unknown"), ("experience", "-1"), ("experience", "nan")]:
            with self.subTest(field=field):
                response = self.client.post("/api/candidates", data={**self.details, field: value})
                self.assertEqual(response.status_code, 422, response.text)

    def test_records_survive_reinitialization(self):
        self.assertEqual(self.create().status_code, 201)
        main.initialize()
        self.assertEqual(len(self.client.get("/api/candidates").json()), 1)
        self.assertEqual([department['name'] for department in self.client.get("/api/departments").json()],
                         [department[0] for department in main.DEFAULT_DEPARTMENTS])

    def test_department_migration_preserves_existing_candidates(self):
        with main.db() as conn:
            conn.execute("DELETE FROM schema_migrations WHERE name = 'team_departments_v1'")
            conn.execute("DELETE FROM departments")
            conn.execute("INSERT INTO departments(name) VALUES ('Engineering')")
            engineering_id = conn.execute("SELECT id FROM departments WHERE name = 'Engineering'").fetchone()[0]
            conn.execute("INSERT INTO departments(name) VALUES ('Design')")
        self.details['department_id'] = str(engineering_id)
        candidate = self.create(("resume.pdf", b"%PDF-1.4 existing", "application/pdf")).json()
        main.initialize()
        main.initialize()
        names = [d['name'] for d in self.client.get('/api/departments').json()]
        self.assertIn('Engineering', names)
        self.assertNotIn('Design', names)
        self.assertEqual(len(names), 8)
        self.assertEqual(self.client.get('/api/candidates').json()[0]['department_id'], engineering_id)
        self.assertEqual(self.client.get(f"/api/candidates/{candidate['id']}/cv").content, b"%PDF-1.4 existing")

    def test_legacy_cv_migrates_once_and_no_longer_requires_file(self):
        candidate_id = self.create().json()['id']
        content = b'%PDF-1.4 legacy CV'
        main.UPLOADS.mkdir()
        old_path = main.UPLOADS / 'legacy.pdf'
        old_path.write_bytes(content)
        with main.db() as conn:
            conn.execute("UPDATE candidates SET cv_name = ?, cv_path = ?, cv_type = ? WHERE id = ?",
                         ('legacy.pdf', 'legacy.pdf', 'application/pdf', candidate_id))
        main.initialize()
        self.assertTrue(old_path.exists(), 'Migration should retain the legacy file as a backup')
        old_path.unlink()
        main.initialize()
        with main.db() as conn:
            self.assertIsNone(conn.execute('SELECT cv_path FROM candidates WHERE id = ?', (candidate_id,)).fetchone()[0])
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM candidate_cvs').fetchone()[0], 1)
        self.assertEqual(self.client.get(f'/api/candidates/{candidate_id}/cv').content, content)
        self.assertEqual(self.client.get('/api/departments').json()[0]['cv_count'], 1)

    def test_missing_legacy_file_rolls_back_migration(self):
        candidate_id = self.create().json()['id']
        with main.db() as conn:
            conn.execute("UPDATE candidates SET cv_name = 'missing.pdf', cv_path = 'missing.pdf', cv_type = 'application/pdf' WHERE id = ?", (candidate_id,))
        with self.assertRaisesRegex(RuntimeError, 'Cannot migrate CV'):
            main.initialize()
        with main.db() as conn:
            self.assertEqual(conn.execute('SELECT cv_path FROM candidates WHERE id = ?', (candidate_id,)).fetchone()[0], 'missing.pdf')
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM candidate_cvs').fetchone()[0], 0)

    def test_failed_cv_write_rolls_back_candidate_and_metadata(self):
        candidate_id = self.create(('original.pdf', b'%PDF-1.4 original', 'application/pdf')).json()['id']
        with main.db() as conn:
            conn.execute("CREATE TRIGGER reject_test_cv BEFORE INSERT ON candidate_cvs BEGIN SELECT RAISE(ABORT, 'test failure'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.client.put(f'/api/candidates/{candidate_id}', data={**self.details, 'name': 'Changed Name'}, files={'cv': ('new.pdf', b'%PDF-1.4 new', 'application/pdf')})
        record = self.client.get('/api/candidates').json()[0]
        self.assertEqual(record['name'], self.details['name'])
        self.assertEqual(record['cv_name'], 'original.pdf')
        self.assertEqual(self.client.get(f'/api/candidates/{candidate_id}/cv').content, b'%PDF-1.4 original')
        with self.assertRaises(sqlite3.IntegrityError):
            self.create(('new.pdf', b'%PDF-1.4 new', 'application/pdf'))
        self.assertEqual(len(self.client.get('/api/candidates').json()), 1)

    def test_database_only_backup_restores_candidate_and_cv(self):
        content = b'%PDF-1.4 portable CV'
        candidate_id = self.create(('resume.pdf', content, 'application/pdf')).json()['id']
        restore_dir = main.DATA / 'restored'
        restore_dir.mkdir()
        with main.db() as conn:
            target = sqlite3.connect(restore_dir / 'hr.sqlite3')
            try:
                conn.backup(target)
            finally:
                target.close()
        main.DATA = restore_dir
        main.UPLOADS = restore_dir / 'uploads'
        main.initialize()
        self.assertEqual(self.client.get('/api/candidates').json()[0]['name'], self.details['name'])
        self.assertEqual(self.client.get(f'/api/candidates/{candidate_id}/cv').content, content)
        self.assert_no_upload_files()


if __name__ == "__main__":
    unittest.main()
