import { NavLink } from 'react-router';
import {
  LayoutDashboard,
  FolderKanban,
  TestTube2,
  Play,
  FileBarChart,
  Settings,
  LogOut,
  Bug,
  Users,
  Activity,
} from 'lucide-react';
import { useAuthStore } from '@/stores/auth.store';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';
import { CatEyeGlasses } from '@/components/icons/cat-eye-glasses';

interface NavItem {
  nameKey: string;
  href: string;
  icon: typeof LayoutDashboard;
}

interface NavGroup {
  labelKey: string;
  items: NavItem[];
}

const navGroups: NavGroup[] = [
  {
    labelKey: 'nav.groupMenu',
    items: [
      { nameKey: 'nav.dashboard', href: '/dashboard', icon: LayoutDashboard },
      { nameKey: 'nav.clients', href: '/clients', icon: Users },
      { nameKey: 'nav.activity', href: '/activity', icon: Activity },
      { nameKey: 'nav.projects', href: '/projects', icon: FolderKanban },
    ],
  },
  {
    labelKey: 'nav.groupTesting',
    items: [
      { nameKey: 'nav.testCases', href: '/test-cases', icon: TestTube2 },
      { nameKey: 'nav.testRunner', href: '/runner', icon: Play },
      { nameKey: 'nav.reports', href: '/reports', icon: FileBarChart },
    ],
  },
  {
    labelKey: 'nav.groupIntegration',
    items: [{ nameKey: 'nav.jira', href: '/jira', icon: Bug }],
  },
  {
    labelKey: 'nav.groupConfig',
    items: [{ nameKey: 'nav.settings', href: '/settings', icon: Settings }],
  },
];

export function Sidebar() {
  const { t } = useTranslation();
  const signOut = useAuthStore((s) => s.signOut);
  const user = useAuthStore((s) => s.user);

  return (
    <div className="flex h-full w-64 flex-col bg-gradient-to-b from-[#1e1b4b] to-[#312e81]">
      <div className="flex h-16 items-center gap-2 px-6">
        <CatEyeGlasses className="h-7 w-7 text-[#a78bfa]" />
        <span className="text-lg font-bold text-white">{t('nav.appName')}</span>
      </div>

      <nav className="flex-1 space-y-6 overflow-y-auto px-4 py-2">
        {navGroups.map((group) => (
          <div key={group.labelKey}>
            <span className="px-3 text-[11px] font-semibold uppercase tracking-wider text-white/40">
              {t(group.labelKey)}
            </span>
            <div className="mt-2 space-y-1">
              {group.items.map((item) => (
                <NavLink
                  key={item.nameKey}
                  to={item.href}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                      isActive
                        ? 'bg-white/10 text-white border-l-2 border-[#a78bfa]'
                        : 'text-white/70 hover:bg-[#312e81] hover:text-white',
                    )
                  }
                >
                  <item.icon className="h-4 w-4" />
                  {t(item.nameKey)}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div className="border-t border-white/10 p-4">
        {user?.email && (
          <p className="mb-2 truncate px-3 text-xs text-white/50">
            {user.email}
          </p>
        )}
        <button
          onClick={signOut}
          className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-white/70 transition-colors hover:bg-white/5 hover:text-white"
        >
          <LogOut className="h-4 w-4" />
          {t('nav.signOut')}
        </button>
      </div>
    </div>
  );
}
