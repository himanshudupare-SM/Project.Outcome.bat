import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { EmptyState, LoadingBlock, Pill } from '../ui/index.js';

interface Hit {
  kind: 'task' | 'epic' | 'project' | 'comment';
  id: string;
  title: string;
  subtitle: string | null;
  projectKey: string | null;
  taskRef: string | null;
}

export function Search(): JSX.Element {
  const { orgSlug = '' } = useParams();
  const [term, setTerm] = useState('');
  const [submitted, setSubmitted] = useState('');

  const results = useQuery({
    queryKey: ['search', orgSlug, submitted],
    queryFn: () => api.get<{ items: Hit[] }>(`/orgs/${orgSlug}/search?q=${encodeURIComponent(submitted)}`),
    enabled: submitted.trim().length > 0,
  });

  const linkFor = (hit: Hit): string => {
    if (hit.kind === 'project' && hit.projectKey) return `/o/${orgSlug}/p/${hit.projectKey}/board`;
    if (hit.taskRef && hit.projectKey) return `/o/${orgSlug}/p/${hit.projectKey}/t/${hit.taskRef.split('-').pop()}`;
    return `/o/${orgSlug}`;
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Search</h1>
          <div className="page-sub">Tasks, epics, projects and comments you have access to.</div>
        </div>
      </div>

      <form
        className="row"
        style={{ marginBottom: 14 }}
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(term);
        }}
      >
        <input
          className="input"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Search everything…"
          aria-label="Search query"
          autoFocus
        />
        <button className="btn btn-primary" type="submit">
          Search
        </button>
      </form>

      {results.isLoading && submitted && <LoadingBlock label="Searching" />}
      {submitted && results.data && (
        <div className="card">
          {results.data.items.length === 0 ? (
            <EmptyState title="No matches" body="Try fewer or different words." />
          ) : (
            results.data.items.map((hit) => (
              <Link key={`${hit.kind}:${hit.id}`} className="list-row" to={linkFor(hit)}>
                <Pill>{hit.kind}</Pill>
                {hit.taskRef && <span className="ref">{hit.taskRef}</span>}
                <span style={{ flex: 1 }}>
                  <span className="list-title">{hit.title}</span>
                  {hit.subtitle && <div className="page-sub">{hit.subtitle}</div>}
                </span>
              </Link>
            ))
          )}
        </div>
      )}
      {!submitted && <EmptyState title="Start typing" body="Search across everything in this organization." />}
    </>
  );
}
