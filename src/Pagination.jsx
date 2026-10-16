import React from 'react';

export default function Pagination({ page, total, pageSize = 100, onChange, disabled = false, label = 'records' }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return <nav className="pagination" aria-label={`${label} pagination`}>
    <span>{total ? (page - 1) * pageSize + 1 : 0}–{Math.min(page * pageSize, total)} of {total} {label}</span>
    <div><button type="button" className="button secondary small" disabled={disabled || page <= 1} onClick={() => onChange(page - 1)}>Previous</button>
      <span>Page {page} of {pages}</span>
      <button type="button" className="button secondary small" disabled={disabled || page >= pages} onClick={() => onChange(page + 1)}>Next</button></div>
  </nav>;
}
