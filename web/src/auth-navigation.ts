export function loginLocation(path = location.pathname, search = location.search) {
  const query = new URLSearchParams({ next: `${path}${search}` });
  const invite = new URLSearchParams(search).get('invite');
  if (invite) query.set('invite', invite);
  return `/login?${query}`;
}

export function loginReturnLocation(search: string, role: string) {
  const next = new URLSearchParams(search).get('next') || '/';
  try {
    const url = new URL(next, location.origin);
    if (!next.startsWith('/') || next.startsWith('//') || url.origin !== location.origin
      || /[\\\r\n]/.test(next) || url.pathname === '/login'
      || /^\/(?:api|open|assets|admin-assets)(?:\/|$)/.test(url.pathname)) return '/';
    if (/^\/admin(?:\/|$)/.test(url.pathname) && role !== 'admin') return '/';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return '/'; }
}

export function notifySessionExpired() {
  window.dispatchEvent(new Event('gptreg:session-expired'));
}
