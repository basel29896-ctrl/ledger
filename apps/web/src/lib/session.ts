'use client';

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { api } from './api';

export interface Session {
  id: string;
  email: string;
  tenantId: string;
  permissions: string[];
}

/** The signed-in user, or null. Never cached across a sign-out. */
export function useSession(): UseQueryResult<Session | null> {
  return useQuery<Session | null>({
    queryKey: ['session'],
    queryFn: async () => {
      try {
        return await api.get<Session>('/auth/me');
      } catch {
        return null;
      }
    },
    staleTime: 60_000,
    retry: false,
  });
}

export function can(session: Session | null | undefined, permission: string): boolean {
  return session?.permissions.includes(permission) ?? false;
}
