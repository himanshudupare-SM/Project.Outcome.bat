import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MeResponse } from '@outcome/shared';
import { api, ApiError } from './api.js';

interface SessionValue {
  me: MeResponse | null;
  loading: boolean;
  error: ApiError | null;
  refetch: () => void;
}

const SessionContext = createContext<SessionValue>({
  me: null,
  loading: true,
  error: null,
  refetch: () => undefined,
});

export function SessionProvider({ children }: { children: ReactNode }): JSX.Element {
  const query = useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<MeResponse>('/auth/me'),
    retry: false,
    // A 401 is a normal state (signed out), not an error to retry.
    staleTime: 30_000,
  });

  const value = useMemo<SessionValue>(
    () => ({
      me: query.data ?? null,
      loading: query.isLoading,
      error: query.error instanceof ApiError ? query.error : null,
      refetch: () => void query.refetch(),
    }),
    [query.data, query.isLoading, query.error, query.refetch],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  return useContext(SessionContext);
}

export function useLogout(): () => void {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => api.post('/auth/logout'),
    onSettled: () => {
      queryClient.clear();
      window.location.assign('/login');
    },
  });
  return () => mutation.mutate();
}
