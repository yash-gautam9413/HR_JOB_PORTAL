"""Pagination regression tests; all records live in an isolated temporary DB."""
import unittest

from backend import main, test_api


class PaginationTests(unittest.TestCase):
    setUp = test_api.HRWorkflowTests.setUp
    tearDown = test_api.HRWorkflowTests.tearDown

    def seed(self, count=205):
        with main.db() as conn:
            for i in range(count):
                cursor = conn.execute("""INSERT INTO candidates(name, email, role, department_id, status)
                    VALUES (?, '', 'Developer', ?, ?)""",
                    (f'Person {i:03}', self.department, 'Hired' if i % 2 else 'New'))
                candidate_id = cursor.lastrowid
                conn.execute('INSERT INTO candidate_cvs(candidate_id, content) VALUES (?, ?)', (candidate_id, b'%PDF-test'))
                conn.execute('INSERT INTO drive_imports(file_id, candidate_id, folder_id) VALUES (?, ?, ?)',
                             (f'file-{i}', candidate_id, 'folder-ai'))

    def test_pages_are_bounded_stable_and_totals_are_global(self):
        self.seed()
        pages = [self.client.get(f'/api/candidates/page?page={n}').json() for n in (1, 2, 3)]
        self.assertEqual([len(p['items']) for p in pages], [100, 100, 5])
        self.assertTrue(all(p['total'] == 205 and p['pages'] == 3 for p in pages))
        ids = [item['id'] for p in pages for item in p['items']]
        self.assertEqual(len(set(ids)), 205)
        self.assertEqual(ids, sorted(ids, reverse=True))
        self.assertNotIn('content', pages[0]['items'][0])
        self.assertEqual(self.client.get('/api/summary').json(), {'total': 205, 'cvs': 205, 'active': 103})
        self.assertEqual(len(self.client.get('/api/candidates/page?page_size=5').json()['items']), 5)

    def test_filters_sort_and_bulk_selection_cover_all_pages(self):
        self.seed()
        url = f'/api/candidates/page?department_id={self.department}&status=New&sort=name'
        first = self.client.get(url).json()
        second = self.client.get(url + '&page=2').json()
        self.assertEqual(first['total'], 103)
        self.assertEqual(first['items'][0]['name'], 'Person 000')
        self.assertEqual(len(second['items']), 3)
        ids = self.client.get(f'/api/candidates/selection?department_id={self.department}&status=New').json()['ids']
        self.assertEqual(set(ids), {c['id'] for c in first['items'] + second['items']})
        self.assertEqual(self.client.get('/api/candidates/page?q=person%20004').json()['total'], 1)
        self.assertEqual(self.client.get('/api/candidates/page?q=%25').json()['total'], 0)
        other = self.client.get('/api/departments').json()[1]['id']
        self.assertEqual(self.client.get(f'/api/candidates/page?department_id={other}').json()['total'], 0)

    def test_empty_invalid_and_deleted_last_pages(self):
        self.assertEqual(self.client.get('/api/candidates/page?page=8').json()['page'], 1)
        for query in ['page=0', 'page=-1', 'page_size=101', 'page_size=0', 'sort=invalid']:
            self.assertEqual(self.client.get('/api/candidates/page?' + query).status_code, 422)
        self.seed(101)
        last = self.client.get('/api/candidates/page?page=2').json()['items'][0]['id']
        self.client.delete(f'/api/candidates/{last}')
        result = self.client.get('/api/candidates/page?page=2').json()
        self.assertEqual(result['page'], 1)
        self.assertEqual(result['total'], 100)
        self.assertEqual(len(result['items']), 100)

    def test_history_paging_and_duplicate_check_are_bounded(self):
        self.seed()
        first = self.client.get('/api/drive/history').json()
        last = self.client.get('/api/drive/history?page=3').json()
        self.assertEqual((len(first['items']), len(last['items']), first['total']), (100, 5, 205))
        self.assertEqual(self.client.get('/api/drive/history?page=99').json()['page'], 3)
        response = self.client.post('/api/drive/check-imported', headers={'X-HR-Request': 'drive-import'},
                                    json=['file-0', 'file-204', 'not-imported'])
        self.assertEqual(set(response.json()['ids']), {'file-0', 'file-204'})
        self.assertEqual(self.client.post('/api/drive/check-imported', json=['file-0']).status_code, 403)
        self.assertEqual(self.client.post('/api/drive/check-imported', headers={'X-HR-Request': 'drive-import'}, json=['x'] * 1001).status_code, 422)


if __name__ == '__main__':
    unittest.main()
