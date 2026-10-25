import { describe, expect, it } from 'vitest';
import { portalPath } from '../portalPath';

describe('Client portal full-page redirects', () => {
  it.each(['/', '/portal/', '/portal'])('keeps invitation context inside the configured base %s', base => {
    const prefix = base === '/' ? '' : '/portal';
    expect(portalPath('/invite?token=wli_example', base)).toBe(prefix + '/invite?token=wli_example');
    expect(portalPath('/access-removed', base)).toBe(prefix + '/access-removed');
    expect(portalPath('/auth/login', base)).toBe(prefix + '/auth/login');
  });
});
