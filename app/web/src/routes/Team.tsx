import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ORG_ROLES, type OrgRole } from '@outcome/shared';
import { useMembers } from '../lib/queries.js';
import { api, ApiError } from '../lib/api.js';
import { useSession } from '../lib/session.js';
import { Avatar, Button, Field, LoadingBlock, Pill, useToast } from '../ui/index.js';

interface InvitationRow {
  id: string;
  email: string;
  role: 'admin' | 'member';
  createdAt: string;
  expiresAt: string;
}

export function Team(): JSX.Element {
  const { orgSlug = '' } = useParams();
  const { me } = useSession();
  const members = useMembers(orgSlug);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [fields, setFields] = useState<Record<string, string>>({});

  const myRole = me?.orgs.find((o) => o.slug === orgSlug)?.role;
  const canManage = myRole === 'owner' || myRole === 'admin';

  const invitations = useQuery({
    queryKey: ['invitations', orgSlug],
    queryFn: () => api.get<InvitationRow[]>(`/orgs/${orgSlug}/invitations`),
    enabled: canManage,
  });

  const invite = useMutation({
    mutationFn: (input: { email: string; role: string }) =>
      api.post<{ inviteUrl: string }>(`/orgs/${orgSlug}/invitations`, input),
    onSuccess: (created) => {
      setEmail('');
      setFields({});
      void queryClient.invalidateQueries({ queryKey: ['invitations', orgSlug] });
      // Email delivery is post-MVP, so surface the link for the inviter to share.
      void navigator.clipboard?.writeText(new URL(created.inviteUrl, window.location.origin).toString());
      toast.push('Invitation created — link copied to your clipboard', 'success');
    },
    onError: (err) => {
      if (err instanceof ApiError) {
        setFields(err.fields);
        if (Object.keys(err.fields).length === 0) toast.push(err.body.detail ?? err.body.title, 'error');
      }
    },
  });

  const changeRole = useMutation({
    mutationFn: ({ userId, next }: { userId: string; next: OrgRole }) =>
      api.patch(`/orgs/${orgSlug}/members/${userId}`, { role: next }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['members', orgSlug] });
      toast.push('Role updated', 'success');
    },
    onError: (err) =>
      toast.push(err instanceof ApiError ? (err.body.detail ?? err.body.title) : 'Could not change role', 'error'),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/orgs/${orgSlug}/invitations/${id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['invitations', orgSlug] }),
  });

  if (members.isLoading) return <LoadingBlock label="Loading team" />;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Team</h1>
          <div className="page-sub">{members.data?.length ?? 0} members</div>
        </div>
      </div>

      {canManage && (
        <div className="card card-pad" style={{ marginBottom: 16 }}>
          <h2 style={{ marginBottom: 10 }}>Invite someone</h2>
          <form
            className="row"
            style={{ alignItems: 'flex-start' }}
            onSubmit={(e) => {
              e.preventDefault();
              invite.mutate({ email, role });
            }}
          >
            <div style={{ flex: 1 }}>
              <Field label="Email" error={fields['email']} required>
                {(props) => (
                  <input
                    {...props}
                    className="input"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="teammate@company.com"
                    required
                  />
                )}
              </Field>
            </div>
            <div style={{ width: 140 }}>
              <Field label="Role">
                {(props) => (
                  <select
                    {...props}
                    className="select"
                    value={role}
                    onChange={(e) => setRole(e.target.value as 'admin' | 'member')}
                  >
                    <option value="member">Member</option>
                    <option value="admin">Admin</option>
                  </select>
                )}
              </Field>
            </div>
            <Button type="submit" variant="primary" loading={invite.isPending} style={{ marginTop: 20 }}>
              Invite
            </Button>
          </form>

          {(invitations.data?.length ?? 0) > 0 && (
            <>
              <h3 style={{ margin: '10px 0 6px' }}>Pending invitations</h3>
              {invitations.data?.map((i) => (
                <div className="row" key={i.id} style={{ padding: '4px 0' }}>
                  <span style={{ flex: 1 }}>{i.email}</span>
                  <Pill>{i.role}</Pill>
                  <Button size="sm" variant="ghost" onClick={() => revoke.mutate(i.id)}>
                    Revoke
                  </Button>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 40 }} />
              <th>Name</th>
              <th>Email</th>
              <th style={{ width: 160 }}>Role</th>
            </tr>
          </thead>
          <tbody>
            {members.data?.map((m) => (
              <tr key={m.userId}>
                <td>
                  <Avatar name={m.name} />
                </td>
                <td className="list-title">{m.name}</td>
                <td className="page-sub">{m.email}</td>
                <td>
                  {canManage ? (
                    <select
                      className="select"
                      value={m.role}
                      onChange={(e) => changeRole.mutate({ userId: m.userId, next: e.target.value as OrgRole })}
                      aria-label={`Role for ${m.name}`}
                      disabled={myRole !== 'owner' && m.role === 'owner'}
                    >
                      {ORG_ROLES.map((r) => (
                        <option key={r} value={r} disabled={r === 'owner' && myRole !== 'owner'}>
                          {r}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <Pill>{m.role}</Pill>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
