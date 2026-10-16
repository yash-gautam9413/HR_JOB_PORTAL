import sqlite3
import unittest

from backend import main
from backend import test_api


class DriveImportTests(unittest.TestCase):
    setUp = test_api.HRWorkflowTests.setUp
    tearDown = test_api.HRWorkflowTests.tearDown
    headers = {'X-HR-Request': 'drive-import'}

    def mapping(self, folder='folder-ai', department=None):
        response = self.client.post('/api/drive/mappings', headers=self.headers, json={
            'folder_id': folder, 'folder_name': 'AI CVs', 'department_id': department or self.department,
            'resource_key': 'resource-key',
        })
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()['id']

    def import_cv(self, mapping_id, file_id='drive-file-1', content=b'%PDF-1.4 imported CV', **extra):
        return self.client.post('/api/drive/import', headers=self.headers, data={
            'mapping_id': str(mapping_id), 'file_id': file_id, 'name': 'Reviewed Candidate', **extra,
        }, files={'cv': ('resume.pdf', content, 'application/pdf')})

    def test_settings_require_app_header_and_persist_public_client_id(self):
        payload = {'client_id': '123456789-example.apps.googleusercontent.com'}
        self.assertEqual(self.client.put('/api/drive/settings', json=payload).status_code, 403)
        self.assertEqual(self.client.put('/api/drive/settings', headers=self.headers, json=payload).status_code, 200)
        main.initialize()
        self.assertEqual(self.client.get('/api/drive/settings').json(), payload)
        self.assertEqual(self.client.put('/api/drive/settings', headers=self.headers, json={'client_id': 'not-a-client'}).status_code, 422)

    def test_import_stores_cv_in_mapped_department_and_skips_retry(self):
        mapping_id = self.mapping()
        response = self.import_cv(mapping_id)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['status'], 'imported')
        candidate_id = response.json()['candidate_id']
        candidate = self.client.get('/api/candidates').json()[0]
        self.assertEqual(candidate['department_id'], self.department)
        self.assertEqual(candidate['email'], '')
        self.assertEqual(self.client.get(f'/api/candidates/{candidate_id}/cv').content, b'%PDF-1.4 imported CV')
        self.assertEqual(self.import_cv(mapping_id).json(), {'status': 'skipped', 'candidate_id': candidate_id})
        self.assertEqual(len(self.client.get('/api/candidates').json()), 1)
        self.assertEqual(self.client.get('/api/drive/mappings').json()[0]['imported_count'], 1)
        self.assertEqual(self.client.get('/api/drive/mappings').json()[0]['resource_key'], 'resource-key')
        self.assertFalse(main.UPLOADS.exists())
        # Imported profiles remain editable without inventing an email address.
        edit = self.client.put(f'/api/candidates/{candidate_id}', data={
            'name': 'Updated Name', 'email': '', 'role': 'AI Engineer', 'department_id': str(self.department),
        })
        self.assertEqual(edit.status_code, 200, edit.text)

    def test_invalid_mapping_file_and_email_create_no_candidates(self):
        self.assertEqual(self.import_cv(999).status_code, 404)
        mapping_id = self.mapping()
        self.assertEqual(self.import_cv(mapping_id, content=b'not a pdf').status_code, 422)
        self.assertEqual(self.import_cv(mapping_id, email='invalid').status_code, 422)
        self.assertEqual(self.import_cv(mapping_id, file_id='../bad').status_code, 422)
        self.assertEqual(self.client.get('/api/candidates').json(), [])
        self.assertEqual(self.client.get('/api/drive/imports').json(), [])

    def test_modified_date_persists_separately_and_retry_keeps_original(self):
        mapping_id = self.mapping()
        response = self.import_cv(mapping_id, modified_time='2026-09-26T14:30:00+05:30')
        self.assertEqual(response.status_code, 200, response.text)
        main.initialize()
        candidate = self.client.get('/api/candidates').json()[0]
        self.assertEqual(candidate['drive_modified_time'], '2026-09-26T09:00:00Z')
        self.assertNotEqual(candidate['created_at'], candidate['drive_modified_time'])
        self.assertEqual(self.client.get('/api/drive/imports').json()[0]['modified_time'], '2026-09-26T09:00:00Z')
        retry = self.import_cv(mapping_id, modified_time='2026-10-01T00:00:00Z')
        self.assertEqual(retry.json()['status'], 'skipped')
        self.assertEqual(self.client.get('/api/candidates').json()[0]['drive_modified_time'], '2026-09-26T09:00:00Z')

    def test_modified_date_is_optional_but_must_include_timezone(self):
        mapping_id = self.mapping()
        for value in ['not-a-date', '2026-09-26', '2026-09-26T09:00:00']:
            self.assertEqual(self.import_cv(mapping_id, modified_time=value).status_code, 422)
        self.assertEqual(self.client.get('/api/candidates').json(), [])
        self.assertEqual(self.import_cv(mapping_id).status_code, 200)
        self.assertIsNone(self.client.get('/api/candidates').json()[0]['drive_modified_time'])

    def test_existing_database_migration_preserves_cv_and_import(self):
        mapping_id = self.mapping()
        candidate_id = self.import_cv(mapping_id).json()['candidate_id']
        with main.db() as conn:
            conn.execute('ALTER TABLE drive_imports DROP COLUMN modified_time')
        main.initialize()
        main.initialize()
        candidate = self.client.get('/api/candidates').json()[0]
        self.assertEqual(candidate['id'], candidate_id)
        self.assertIsNone(candidate['drive_modified_time'])
        self.assertEqual(self.client.get(f'/api/candidates/{candidate_id}/cv').content, b'%PDF-1.4 imported CV')
        self.assertEqual(len(self.client.get('/api/drive/imports').json()), 1)

    def test_unlink_and_remap_keep_existing_candidates(self):
        mapping_id = self.mapping()
        first = self.import_cv(mapping_id).json()['candidate_id']
        next_department = self.client.get('/api/departments').json()[1]['id']
        self.assertEqual(self.mapping(department=next_department), mapping_id)
        second = self.import_cv(mapping_id, file_id='drive-file-2').json()['candidate_id']
        with main.db() as conn:
            self.assertEqual(conn.execute('SELECT department_id FROM candidates WHERE id = ?', (first,)).fetchone()[0], self.department)
            self.assertEqual(conn.execute('SELECT department_id FROM candidates WHERE id = ?', (second,)).fetchone()[0], next_department)
        self.assertEqual(self.client.delete(f'/api/drive/mappings/{mapping_id}', headers=self.headers).status_code, 204)
        self.assertEqual(len(self.client.get('/api/candidates').json()), 2)
        self.assertEqual(len(self.client.get('/api/drive/imports').json()), 2)

    def test_delete_candidate_cascades_source_and_allows_reimport(self):
        mapping_id = self.mapping()
        candidate_id = self.import_cv(mapping_id).json()['candidate_id']
        self.client.delete(f'/api/candidates/{candidate_id}')
        self.assertEqual(self.client.get('/api/drive/imports').json(), [])
        self.assertEqual(self.import_cv(mapping_id).json()['status'], 'imported')

    def test_import_transaction_rolls_back_on_failure(self):
        mapping_id = self.mapping()
        with main.db() as conn:
            conn.execute("CREATE TRIGGER reject_test_import BEFORE INSERT ON drive_imports BEGIN SELECT RAISE(ABORT, 'test failure'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.import_cv(mapping_id)
        self.assertEqual(self.client.get('/api/candidates').json(), [])
        with main.db() as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM candidate_cvs').fetchone()[0], 0)

    def test_delete_empty_department_removes_mapping_and_stays_deleted(self):
        self.mapping()
        other_id = self.client.get('/api/departments').json()[1]['id']
        self.mapping(folder='other-folder', department=other_id)
        endpoint = f'/api/departments/{self.department}'
        self.assertEqual(self.client.delete(endpoint).status_code, 403)
        headers = {'X-HR-Request': 'delete-department'}
        self.assertEqual(self.client.delete(endpoint, headers=headers).status_code, 204)
        main.initialize()
        self.assertNotIn(self.department, [d['id'] for d in self.client.get('/api/departments').json()])
        self.assertEqual([m['folder_id'] for m in self.client.get('/api/drive/mappings').json()], ['other-folder'])
        self.assertEqual(self.client.delete(endpoint, headers=headers).status_code, 404)

    def test_delete_populated_department_is_blocked_without_losing_cv_or_mapping(self):
        mapping_id = self.mapping()
        candidate_id = self.import_cv(mapping_id).json()['candidate_id']
        response = self.client.delete(f'/api/departments/{self.department}', headers={'X-HR-Request': 'delete-department'})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(len(self.client.get('/api/candidates').json()), 1)
        self.assertEqual(self.client.get(f'/api/candidates/{candidate_id}/cv').content, b'%PDF-1.4 imported CV')
        self.assertEqual(self.client.get('/api/drive/mappings').json()[0]['id'], mapping_id)

    def test_department_delete_rolls_back_mapping_removal_on_failure(self):
        self.mapping()
        with main.db() as conn:
            conn.execute("CREATE TRIGGER reject_department_delete BEFORE DELETE ON departments BEGIN SELECT RAISE(ABORT, 'test failure'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.client.delete(f'/api/departments/{self.department}', headers={'X-HR-Request': 'delete-department'})
        self.assertEqual(len(self.client.get('/api/drive/mappings').json()), 1)
        self.assertIn(self.department, [d['id'] for d in self.client.get('/api/departments').json()])

    def test_bulk_delete_removes_only_selected_profiles_cvs_and_imports(self):
        mapping_id = self.mapping()
        ids = [self.import_cv(mapping_id, file_id=f'bulk-file-{i}').json()['candidate_id'] for i in range(3)]
        headers = {'X-HR-Request': 'bulk-delete'}
        response = self.client.post('/api/candidates/bulk-delete', headers=headers, json={'ids': [ids[0], ids[1], ids[0]]})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {'deleted_count': 2})
        self.assertEqual([c['id'] for c in self.client.get('/api/candidates').json()], [ids[2]])
        with main.db() as conn:
            self.assertEqual([r[0] for r in conn.execute('SELECT candidate_id FROM candidate_cvs')], [ids[2]])
            self.assertEqual([r[0] for r in conn.execute('SELECT candidate_id FROM drive_imports')], [ids[2]])
        self.assertEqual(self.client.get(f'/api/candidates/{ids[0]}/cv').status_code, 404)
        self.assertEqual(len(self.client.get('/api/drive/mappings').json()), 1)
        self.assertEqual(self.import_cv(mapping_id, file_id='bulk-file-0').json()['status'], 'imported')
        remaining = [c['id'] for c in self.client.get('/api/candidates').json()]
        self.assertEqual(self.client.post('/api/candidates/bulk-delete', headers=headers, json={'ids': remaining}).json()['deleted_count'], 2)
        self.assertEqual(self.client.get('/api/candidates').json(), [])
        self.assertEqual(self.client.get('/api/drive/imports').json(), [])

    def test_bulk_delete_rejects_invalid_requests_and_rolls_back_stale_selection(self):
        candidate_id = self.import_cv(self.mapping()).json()['candidate_id']
        endpoint = '/api/candidates/bulk-delete'
        headers = {'X-HR-Request': 'bulk-delete'}
        self.assertEqual(self.client.post(endpoint, json={'ids': [candidate_id]}).status_code, 403)
        for ids in [[], [0], [-1], ['1'], [True]]:
            self.assertEqual(self.client.post(endpoint, headers=headers, json={'ids': ids}).status_code, 422)
        self.assertEqual(self.client.post(endpoint, headers=headers, json={'ids': [candidate_id, 999999]}).status_code, 409)
        self.assertEqual(len(self.client.get('/api/candidates').json()), 1)
        self.assertEqual(self.client.get(f'/api/candidates/{candidate_id}/cv').content, b'%PDF-1.4 imported CV')
        self.assertEqual(len(self.client.get('/api/drive/imports').json()), 1)


if __name__ == '__main__':
    unittest.main()
