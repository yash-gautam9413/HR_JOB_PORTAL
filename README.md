# PeopleDesk

A local HR dashboard built with **React** and **Python / FastAPI**. Departments organize candidate profiles and uploaded CVs. SQLite preserves all application data, including CV file contents, across restarts.

## Start the project

Run these commands from `D:\HR` with Python 3.10+ and Node.js 20.19+ installed:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
npm.cmd install
npm.cmd run build
.\.venv\Scripts\python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

Open **http://127.0.0.1:8000**. The Python server serves both the built React frontend and API. Restart it after rebuilding the frontend if the build directory did not exist when it started.

After setup, double-click `start.cmd` to start the dashboard. Keep its terminal open while using the app; press Ctrl+C to stop it.

## Frontend development

Keep the Python backend running on port 8000, then use a second terminal:

```powershell
npm.cmd run dev
```

Open the local URL printed by Vite (usually http://127.0.0.1:5173). Vite forwards `/api` requests to the backend.

## Features

- Overview with live candidate, department, CV, and recruitment pipeline counts.
- Seven departments: AI, SEO, CONTENT WRITING, CREATIVE, MARKETING, SHOPIFY, and FULL STACK; create additional departments as needed.
- Add and edit candidate names, contact details, roles, experience, status, and notes.
- Search candidates by name, role, email, or department; filter by department and status.
- Candidate directories load 100 records per page from the backend. Search, filtering, sorting, and totals cover the full database; the Overview loads only five recent profiles.
- Candidate selection is page-local. The separate “Delete all matching candidates” action prepares an explicit ID selection across all filtered pages and still requires confirmation.
- Drive review and import history display 100 rows per page. Review loads folder metadata to support selecting/importing across all pages; CV bytes are downloaded only during import. History is paginated on the backend.
- Upload PDF or DOCX CVs up to 10 MB; replace an existing CV when editing a candidate.
- Preview PDFs in candidate profiles; download PDF and DOCX files.
- Delete candidates and their associated CV with confirmation.
- Responsive layout, keyboard navigation, accessible dialogs, and error/empty states.

The workspace starts without sample candidates. DOCX files download for viewing in Word; in-app previews are for PDFs.

## Data and deployment

All application data is in `backend/data/hr.sqlite3`: departments, candidate details, CV names/types, and the CV file contents as SQLite BLOBs in `candidate_cvs`. New CVs are not saved in an uploads folder. Candidate edits and CV replacement are committed in one transaction; deleting a candidate also deletes their CV record. Lists load metadata only, while preview/download reads the CV bytes from the database.

Back up `backend/data/hr.sqlite3` while the server is stopped. The data directory is excluded from Git. Set `HR_DATA_DIR` to use a different data location.

On startup, CVs from the previous filesystem storage are automatically copied into the database, and their path references are cleared in the same transaction. Missing or empty legacy files stop migration with an error so records are not silently lost. Old files, if any, are retained only as backup copies; the application no longer uses them after successful migration.

This version is a local, single-user workspace and has no login system. It binds to loopback in the commands above. Before deploying for shared HR use, add authentication, role-based access, HTTPS, upload scanning, and managed backups. Do not expose this development server directly to the internet.

Fonts load from Google Fonts with local sans-serif fallbacks; CVs and candidate data stay on your Python server.

## Verification

```powershell
python -m unittest backend.test_api backend.test_drive -v
npm.cmd test
npm.cmd run build
```

API integration tests use isolated temporary data and cover uploads, download headers, replacement, deletion, invalid inputs, file limits, and persistence. API documentation is available at http://127.0.0.1:8000/docs.

## Google Drive folder imports

Open **Drive import** in the sidebar. This feature requires your own Google Cloud OAuth client and Google account consent; it is not connected automatically through ChatGPT.

### One-time setup

1. Create/select a project in [Google Cloud](https://console.cloud.google.com/) and enable the Google Drive API.
2. Configure the OAuth consent screen. For an external app in Testing, add the Google account you will use as a test user. Add the `https://www.googleapis.com/auth/drive.readonly` scope.
3. Create an OAuth client with application type **Web application**. Under Authorized JavaScript origins add `http://localhost` and `http://localhost:8000`. For the Vite dev server also add `http://localhost:5173`.
4. Use **http://localhost:8000** for Google login. Open Drive import → Connection setup and save the public OAuth Client ID (`….apps.googleusercontent.com`). Do not paste a client secret; this browser authorization flow does not use one.
5. Click **Connect Google Drive** and grant read-only access. Google requires a valid client ID and registered origin; a mismatched origin, unlisted test user, disabled API, or Workspace policy may block consent.

Google documents [client ID setup](https://developers.google.com/identity/oauth2/web/guides/get-google-api-clientid), the [browser token flow](https://developers.google.com/identity/oauth2/web/guides/use-token-model), and [Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth). `drive.readonly` is a restricted scope that permits reading all Drive files, needed here to enumerate existing folder contents; external production deployment can require Google's verification/security assessment. The app only requests files from the folders you enter, and it never changes Drive originals.

### Import workflow

1. Paste the Drive link for a department folder, choose the department, and click **Link folder**. Repeat for AI, SEO, Content Writing, Creative, Marketing, Shopify, and Full Stack as needed. Multiple folders may map to the same department.
2. Click **Review CVs**. All listing pages are loaded. Only files directly in the folder are included; link nested folders separately. Shortcuts and legacy `.doc` files are marked unavailable rather than imported. PDFs, DOCX files, and Google Docs are supported; Google Docs are exported to PDF. The 10 MB per-file limit applies.
3. Review suggested names (derived from filenames, not parsed CV content). Edit names and optionally provide emails and a batch role. Missing emails remain blank; unspecified roles are stored as “Not specified.”
4. Select CVs and click **Import**. Each candidate, CV BLOB, and source file ID is saved atomically in SQLite. A Drive file ID already imported is skipped, including on retry. Identical copies with different Drive IDs are separate files. Re-import does not overwrite an existing candidate when the Drive file changes.
5. Results appear per file, including failures. Retry selected failed files after correcting errors. **Stop after current file** keeps completed imports. Keep the page open while importing; no background or automatic synchronization runs.

Folder mappings, resource keys for shared folder links, the public client ID, and import history are stored in SQLite. Google access tokens stay only in browser memory (never in local storage or the database), expire normally, and are cleared when you reload or disconnect. Reconnect to resume. Disconnecting requests Google token revocation; account permissions can also be managed at https://myaccount.google.com/permissions.

Unlinking a folder keeps imported candidates and CVs. Remapping a folder changes the destination of future imports only. Deleting a candidate deletes the associated CV and Drive source record, allowing that file to be imported again.

Drive tests use mocked Google responses and temporary SQLite databases. Actual Google consent and access require your own configured account and must be verified after setup.
