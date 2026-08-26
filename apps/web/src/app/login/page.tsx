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
    <div className="flex min-h-screen items-center justify-center bg-ink-800 p-4">
      {/* The sign-in card sits on the dark brand ground; the app itself is light. */}
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5 text-mint-100">
          <span className="flex h-9 w-9 items-center justify-center rounded-md bg-mint-300 text-base font-bold text-ink-800">
            ٧
          </span>
          <span className="text-base font-semibold tracking-tight">Accounting</span>
        </div>

        <form
          onSubmit={submit}
          className="space-y-3 rounded-lg border border-ink-600 bg-surface p-6 shadow-lg"
        >
          <h1 className="text-base font-semibold text-ink-800">Sign in</h1>
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
                className="text-center tracking-[0.4em]"
              />
            </Field>
          ) : null}
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>

        <p className="mt-4 text-center text-xs text-ink-300">
          Sessions are cookie-based and expire after 15 minutes of inactivity.
        </p>
      </div>
    </div>
  );
}
