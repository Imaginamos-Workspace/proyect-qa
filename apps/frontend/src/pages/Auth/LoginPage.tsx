import { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router';
import { Github } from 'lucide-react';
import { useAuthStore } from '@/stores/auth.store';
import { GITHUB_ORG } from '@/lib/supabase';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { CatEyeGlasses } from '@/components/icons/cat-eye-glasses';
import { useTranslation } from 'react-i18next';

export function LoginPage() {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [githubLoading, setGithubLoading] = useState(false);

  const signIn = useAuthStore((s) => s.signIn);
  const signInWithGitHub = useAuthStore((s) => s.signInWithGitHub);
  const user = useAuthStore((s) => s.user);
  const authError = useAuthStore((s) => s.authError);
  const clearAuthError = useAuthStore((s) => s.clearAuthError);
  const navigate = useNavigate();

  // Tras el OAuth de GitHub el redirect vuelve a /login; cuando el gate de org
  // aprueba al usuario, lo llevamos al dashboard.
  useEffect(() => {
    if (user) navigate('/dashboard', { replace: true });
  }, [user, navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    clearAuthError();
    setLoading(true);
    try {
      await signIn(email, password);
      navigate('/dashboard');
    } catch (err: any) {
      setError(err.message || t('auth.failedSignIn'));
    } finally {
      setLoading(false);
    }
  };

  const handleGitHub = async () => {
    setError('');
    clearAuthError();
    setGithubLoading(true);
    try {
      await signInWithGitHub(); // redirige a GitHub; en éxito no continúa aquí.
    } catch (err: any) {
      setError(err.message || t('auth.failedSignIn'));
      setGithubLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/50">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <CatEyeGlasses className="h-7 w-7 text-primary" />
          </div>
          <CardTitle>{t('auth.welcomeBack')}</CardTitle>
          <CardDescription>{t('auth.signInDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          {authError === 'not_org_member' && (
            <div className="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {t('auth.notOrgMember', { org: GITHUB_ORG })}
            </div>
          )}

          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={handleGitHub}
            disabled={githubLoading}
          >
            <Github className="mr-2 h-4 w-4" />
            {githubLoading ? t('auth.redirectingToGitHub') : t('auth.continueWithGitHub')}
          </Button>

          <div className="my-4 flex items-center gap-3">
            <span className="h-px flex-1 bg-border" />
            <span className="text-xs uppercase text-muted-foreground">{t('auth.orWithEmail')}</span>
            <span className="h-px flex-1 bg-border" />
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {error}
              </div>
            )}
            <div className="space-y-2">
              <label htmlFor="email" className="text-sm font-medium">{t('auth.emailLabel')}</label>
              <Input
                id="email"
                type="email"
                placeholder={t('auth.emailPlaceholder')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="password" className="text-sm font-medium">{t('auth.passwordLabel')}</label>
              <Input
                id="password"
                type="password"
                placeholder={t('auth.passwordPlaceholder')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? t('auth.signingIn') : t('auth.signIn')}
            </Button>
          </form>
          <p className="mt-4 text-center text-sm text-muted-foreground">
            {t('auth.noAccount')}{' '}
            <Link to="/register" className="text-primary hover:underline">
              {t('auth.signUp')}
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
