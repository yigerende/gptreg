import { describe, expect, it } from 'vitest';
import { loginLocation, loginReturnLocation } from './auth-navigation';
describe('login destinations', () => {
  it('preserves the original route and invitation', () => {
    const url = new URL(loginLocation('/accounts', '?order=one&invite=friend'), location.origin);
    expect(url.searchParams.get('next')).toBe('/accounts?order=one&invite=friend');
    expect(url.searchParams.get('invite')).toBe('friend');
    expect(loginReturnLocation(url.search, 'member')).toBe('/accounts?order=one&invite=friend');
  });
  it.each(['https://outside.test','//outside.test','/\\outside.test','/login','/api/v1/proxies','/admin-assets/a.js'])('rejects unsafe destination %s', next => {
    expect(loginReturnLocation('?'+new URLSearchParams({next}), 'admin')).toBe('/');
  });
  it('only returns administrators to admin pages', () => {
    const search='?next='+encodeURIComponent('/admin/engine/proxies');
    expect(loginReturnLocation(search,'admin')).toBe('/admin/engine/proxies');
    expect(loginReturnLocation(search,'member')).toBe('/');
  });
});
