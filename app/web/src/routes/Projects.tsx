import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { ProjectDetail } from '@outcome/shared';
import { useProjects } from '../lib/queries.js';
import { api, ApiError } from '../lib/api.js';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Dialog, EmptyState, Field, LoadingBlock, Pill, formatDate, useToast } from '../ui/index.js';

export function Projects(): JSX.Element {
  const { orgSlug = '' } = useParams();
  const projects = useProjects(orgSlug);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});

  const create = useMutation({
    mutationFn: (input: { name: string }) => api.post<ProjectDetail>(`/orgs/${orgSlug}/projects`, input),
    onSuccess: (project) => {
      void queryClient.invalidateQueries({ queryKey: ['projects', orgSlug] });
      setOpen(false);
      setName('');
      toast.push(`Created ${project.key} — ${project.name}`, 'success');
    },
    onError: (err) => {
      if (err instanceof ApiError) {
        setFields(err.fields);
        if (Object.keys(err.fields).length === 0) toast.push(err.body.detail ?? err.body.title, 'error');
      }
    },
  });

  if (projects.isLoading) return <LoadingBlock label="Loading projects" />;
  const list = projects.data ?? [];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Projects</h1>
          <div className="page-sub">{list.length} active</div>
        </div>
        <Button variant="primary" onClick={() => setOpen(true)}>
          New project
        </Button>
      </div>

      <div className="card">
        {list.length === 0 ? (
          <EmptyState
            title="No projects yet"
            body="A project holds its own board, statuses and members."
            action={
              <Button variant="primary" onClick={() => setOpen(true)}>
                Create a project
              </Button>
            }
          />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 80 }}>Key</th>
                <th>Name</th>
                <th style={{ width: 90 }}>Open</th>
                <th style={{ width: 90 }}>Done</th>
                <th style={{ width: 120 }}>Blockers</th>
                <th style={{ width: 110 }}>Target</th>
              </tr>
            </thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link className="ref" to={`/o/${orgSlug}/p/${p.key}/board`}>
                      {p.key}
                    </Link>
                  </td>
                  <td>
                    <Link to={`/o/${orgSlug}/p/${p.key}/board`} style={{ color: 'inherit' }}>
                      {p.name}
                    </Link>
                  </td>
                  <td className="num">{p.openCount}</td>
                  <td className="num">{p.doneCount}</td>
                  <td>
                    {p.openBlockerCount > 0 ? (
                      <Pill tone="danger">{p.openBlockerCount} open</Pill>
                    ) : (
                      <span className="page-sub">none</span>
                    )}
                  </td>
                  <td className="num page-sub">{formatDate(p.targetDate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {open && (
        <Dialog
          title="New project"
          onClose={() => setOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button variant="primary" loading={create.isPending} onClick={() => create.mutate({ name })}>
                Create
              </Button>
            </>
          }
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate({ name });
            }}
          >
            <Field
              label="Project name"
              error={fields['name']}
              hint="A short key (like ATLAS) is derived automatically."
              required
            >
              {(props) => (
                <input
                  {...props}
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Checkout Platform Migration"
                  required
                />
              )}
            </Field>
          </form>
        </Dialog>
      )}
    </>
  );
}
