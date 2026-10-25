import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderPortal } from '@/test/renderPortal';
import LegacyInvitationPage from '../LegacyInvitationPage';

describe('Legacy invitation recovery', () => {
  it.each(['/organization-invite', '/i/company-slug'])('preserves personal invitation context from %s', async path => {
    renderPortal(<LegacyInvitationPage />, { path, route: path + '?token=wli_personal' });
    expect(await screen.findByTestId('location')).toHaveTextContent('/invite?token=wli_personal');
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
  });

  it('preserves older opaque personal tokens', async () => {
    const token = 'a'.repeat(64);
    renderPortal(<LegacyInvitationPage />, { path: '/organization-invite', route: '/organization-invite?token=' + token });
    expect(await screen.findByTestId('location')).toHaveTextContent('/invite?token=' + token);
  });

  it.each(['/organization-invite?token=legacy.jwt.example', '/i/company-slug', '/organization-invite'])(
    'offers safe client-only recovery for %s without passwords or staff signup',
    async route => {
      renderPortal(<LegacyInvitationPage />, { path: route.split('?')[0], route });
      expect(await screen.findByText('This older invitation needs a personal link')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Sign in to the client portal' })).toHaveAttribute('href', '/auth/login');
      expect(screen.queryByRole('link', { name: /sign up|register/i })).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
      expect(screen.queryByText('legacy.jwt.example')).not.toBeInTheDocument();
    }
  );
});
