import { Button, Result } from '@/shared/antd-imports';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

/** Keep personal tokens from old URLs; a company-wide link cannot establish a recipient. */
export default function LegacyInvitationPage() {
  const [params] = useSearchParams();
  const { t } = useTranslation();
  const token = params.get('token');
  if (token && /^(?:wli_[A-Za-z0-9]+|[a-fA-F0-9]{64})$/.test(token)) {
    return <Navigate to={`/invite?${new URLSearchParams({ token })}`} replace />;
  }
  return (
    <Result
      status="warning"
      title={t('invite.legacyTitle', { defaultValue: 'This older invitation needs a personal link' })}
      subTitle={t('invite.legacyBody', {
        defaultValue: 'Ask your project team for an invitation sent to your email address. If they already added you, sign in with an email code. No password or staff account is needed.',
      })}
      extra={<Link to="/auth/login"><Button type="primary">{t('invite.clientSignIn', { defaultValue: 'Sign in to the client portal' })}</Button></Link>}
    />
  );
}
