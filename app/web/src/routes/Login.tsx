import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import type { MeResponse } from '@outcome/shared';
import { api, ApiError } from '../lib/api.js';
import { Button, Field } from '../ui/index.js';

export function Login({ mode }: { mode: 'login' | 'signup' }): JSX.Element {
  const isSignup = mode === 'signup';
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setFields({});
    setFormError(null);
    try {
      const me = await api.post<MeResponse>(
        isSignup ? '/auth/signup' : '/auth/login',
        isSignup ? { name, email, password } : { email, password },
      );
      queryClient.setQueryData(['me'], me);
      const invite = params.get('invite');
      if (invite) {
        navigate(`/invite/${invite}`, { replace: true });
        return;
      }
      const first = me.orgs[0];
      navigate(first ? `/o/${first.slug}` : '/onboarding', { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        setFields(err.fields);
        setFormError(Object.keys(err.fields).length > 0 ? null : (err.body.detail ?? err.body.title));
      } else {
        setFormError('Something went wrong. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card card card-pad">
        <div className="brand" style={{ padding: '0 0 16px' }}>
          <span className="brand-mark" />
          Outcome
        </div>
        <h1>{isSignup ? 'Create your account' : 'Sign in'}</h1>
        <p className="page-sub" style={{ marginBottom: 18 }}>
          {isSignup
            ? 'Capture work by talking, not by filling in forms.'
            : 'Welcome back.'}
        </p>

        <form onSubmit={submit} noValidate>
          {formError && (
            <div className="alert alert-error" role="alert" style={{ marginBottom: 14 }}>
              {formError}
            </div>
          )}
          {isSignup && (
            <Field label="Your name" error={fields['name']} required>
              {(props) => (
                <input
                  {...props}
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="name"
                  required
                />
              )}
            </Field>
          )}
          <Field label="Email" error={fields['email']} required>
            {(props) => (
              <input
                {...props}
                className="input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                required
              />
            )}
          </Field>
          <Field
            label="Password"
            error={fields['password']}
            hint={isSignup ? 'At least 10 characters.' : undefined}
            required
          >
            {(props) => (
              <input
                {...props}
                className="input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={isSignup ? 'new-password' : 'current-password'}
                required
              />
            )}
          </Field>
          <Button type="submit" variant="primary" className="btn-block" loading={busy}>
            {isSignup ? 'Create account' : 'Sign in'}
          </Button>
        </form>

        <p className="page-sub" style={{ marginTop: 16, textAlign: 'center' }}>
          {isSignup ? (
            <>
              Already have an account? <Link to="/login">Sign in</Link>
            </>
          ) : (
            <>
              New here? <Link to="/signup">Create an account</Link>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
