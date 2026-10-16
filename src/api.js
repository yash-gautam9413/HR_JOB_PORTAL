export async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      headers: { ...(path.startsWith('/drive') ? { 'X-HR-Request': 'drive-import' } : {}), ...options.headers },
    });
  } catch { throw new Error('Cannot connect to the server. Check that the Python backend is running.'); }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(typeof body.detail === 'string' ? body.detail : body.detail?.[0]?.msg || 'Something went wrong. Please try again.');
  }
  return response.status === 204 ? null : response.json();
}
