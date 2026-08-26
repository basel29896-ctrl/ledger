'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { Button, ErrorBanner, Field, Input } from '../../components/ui';

export default function LoginPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('admin@demo.local');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.post('/auth/login', {
        email,
        password,
        ...(totpCode ? { totpCode } : {}),
      });
      await queryClient.invalidateQueries({ queryKey: ['session'] });
      router.push('/');
    } catch (err) {
      const code = (err as { problem?: { code?: string } }).problem?.code;
      if (code === 'TOTP_REQUIRED') setNeedsTotp(true);
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-3 rounded border border-slate-200 bg-white p-6">
        <h1 className="text-base font-semibold">Sign in</h1>
        <ErrorBanner error={error} />
        <Field label="Email">
          <Input
            type="email"
            value={email}
            autoComplete="username"
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </Field>
        <Field label="Password">
          <Input
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </Field>
        {needsTotp ? (
          <Field label="One-time code">
            <Input
              inputMode="numeric"
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value)}
              maxLength={6}
            />
          </Field>
        ) : null}
        <Button type="submit" disabled={busy} className="w-full justify-center">
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </div>
  );
}
