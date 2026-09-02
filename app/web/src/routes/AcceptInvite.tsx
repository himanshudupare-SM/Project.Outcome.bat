import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api.js';
import { useSession } from '../lib/session.js';
import { Button, LoadingBlock } from '../ui/index.js';

export function AcceptInvite(): JSX.Element {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { me, loading } = useSession();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (loading) return;
    if (!me) {
      navigate(`/login?invite=${encodeURIComponent(token)}`, { replace: true });
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const result = await api.post<{ slug: string }>('/invitations/accept', { token });
        if (cancelled) return;
        await queryClient.invalidateQueries({ queryKey: ['me'] });
        navigate(`/o/${result.slug}`, { replace: true });
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof ApiError
              ? (err.body.detail ?? err.body.title)
              : 'This invitation could not be accepted.',
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loading, me, token, navigate, queryClient]);

  return (
    <div className="auth-wrap">
      <div className="auth-card card card-pad">
        {error ? (
          <>
            <h1>Invitation problem</h1>
            <p className="page-sub" style={{ margin: '8px 0 16px' }}>
              {error}
            </p>
            <Button variant="primary" className="btn-block" onClick={() => navigate('/')}>
              Go to Outcome
            </Button>
          </>
        ) : (
          <>
            <h1>Joining…</h1>
            <LoadingBlock label="Accepting invitation" />
          </>
        )}
      </div>
    </div>
  );
}
