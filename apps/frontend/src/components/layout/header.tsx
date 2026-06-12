import { useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/stores/auth.store';
import { Bell, Search, User, Globe, Menu } from 'lucide-react';

interface HeaderProps {
  /** Abre el drawer del sidebar en mobile. */
  onMenuClick?: () => void;
}

function Breadcrumb() {
  const { t } = useTranslation();
  const location = useLocation();
  const segments = location.pathname.split('/').filter(Boolean);

  return (
    <div className="flex min-w-0 items-center gap-2 text-sm">
      <span className="hidden text-muted-foreground sm:inline">{t('header.home')}</span>
      {segments.map((segment, index) => (
        <span key={segment} className="flex min-w-0 items-center gap-2">
          <span className="hidden text-muted-foreground sm:inline">/</span>
          <span
            className={
              index === segments.length - 1
                ? 'truncate font-medium text-foreground'
                : 'hidden truncate text-muted-foreground sm:inline'
            }
          >
            {segment.charAt(0).toUpperCase() + segment.slice(1).replace(/-/g, ' ')}
          </span>
        </span>
      ))}
    </div>
  );
}

function LanguageSwitcher() {
  const { i18n } = useTranslation();
  const currentLang = i18n.language;

  const toggle = () => {
    const newLang = currentLang === 'en' ? 'es' : 'en';
    i18n.changeLanguage(newLang);
  };

  return (
    <button
      onClick={toggle}
      className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      title={currentLang === 'en' ? 'Cambiar a Español' : 'Switch to English'}
    >
      <Globe className="h-4 w-4" />
      <span className="uppercase">{currentLang}</span>
    </button>
  );
}

export function Header({ onMenuClick }: HeaderProps) {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);

  return (
    <header className="flex h-16 items-center justify-between gap-2 border-b border-purple-100 bg-white px-4 shadow-sm sm:px-6">
      <div className="flex min-w-0 items-center gap-2">
        {/* Hamburguesa (solo mobile) */}
        <button
          onClick={onMenuClick}
          className="-ml-1 rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground lg:hidden"
          aria-label={t('nav.openMenu', 'Abrir menú')}
        >
          <Menu className="h-5 w-5" />
        </button>
        <Breadcrumb />
      </div>

      <div className="flex shrink-0 items-center gap-1 sm:gap-3">
        <LanguageSwitcher />
        <button className="hidden rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground sm:inline-flex">
          <Search className="h-5 w-5" />
        </button>
        <button className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
          <Bell className="h-5 w-5" />
        </button>
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#7c3aed]">
            <User className="h-4 w-4 text-white" />
          </div>
          {user?.email && (
            <span className="hidden max-w-[12rem] truncate text-sm text-muted-foreground md:inline">
              {user.email}
            </span>
          )}
        </div>
      </div>
    </header>
  );
}
