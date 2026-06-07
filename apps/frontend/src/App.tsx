import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router';
import { useAuthStore } from '@/stores/auth.store';
import { AppLayout } from '@/components/layout/app-layout';
import { LoginPage } from '@/pages/Auth/LoginPage';
import { RegisterPage } from '@/pages/Auth/RegisterPage';
import { DashboardPage } from '@/pages/Dashboard/DashboardPage';
import { ProjectsPage } from '@/pages/Projects/ProjectsPage';
import { CreateProjectWizard } from '@/pages/Projects/CreateProjectWizard';
import { ProjectDetailPage } from '@/pages/Projects/ProjectDetailPage';
import { GenerateTestsPage } from '@/pages/Projects/GenerateTestsPage';
import { ModulesListPage } from '@/pages/Projects/ModulesListPage';
import { ModuleDetailPage } from '@/pages/Projects/ModuleDetailPage';
import { TestCasesPage } from '@/pages/TestCases/TestCasesPage';
import { TestRunnerPage } from '@/pages/TestRunner/TestRunnerPage';
import { ReportsPage } from '@/pages/Reports/ReportsPage';
import { ReportDetailPage } from '@/pages/Reports/ReportDetailPage';
import { JiraConfigPage } from '@/pages/JiraConfig/JiraConfigPage';
import { SettingsPage } from '@/pages/Settings/SettingsPage';
import { ClientsPage } from '@/pages/Clients/ClientsPage';
import { ClientDetailPage } from '@/pages/Clients/ClientDetailPage';
import { ActivityPage } from '@/pages/Activity/ActivityPage';
import { BoardPage } from '@/pages/Board/BoardPage';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((s) => s.user);
  const loading = useAuthStore((s) => s.loading);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  const initialize = useAuthStore((s) => s.initialize);

  useEffect(() => {
    initialize();
  }, [initialize]);

  return (
    <BrowserRouter>
      <Routes>
        {/* Public routes */}
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />

        {/* Protected routes */}
        <Route
          element={
            <ProtectedRoute>
              <AppLayout />
            </ProtectedRoute>
          }
        >
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/board" element={<BoardPage />} />
          <Route path="/board/:slug" element={<BoardPage />} />
          <Route path="/clients" element={<ClientsPage />} />
          <Route path="/clients/:slug" element={<ClientDetailPage />} />
          <Route path="/activity" element={<ActivityPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/new" element={<CreateProjectWizard />} />
          <Route path="/projects/:id" element={<ProjectDetailPage />} />
          <Route path="/projects/:id/generate" element={<GenerateTestsPage />} />
          <Route path="/projects/:projectId/modules" element={<ModulesListPage />} />
          <Route path="/projects/:projectId/modules/:moduleId" element={<ModuleDetailPage />} />
          <Route path="/projects/:projectId/test-cases" element={<TestCasesPage />} />
          <Route path="/projects/:projectId/run" element={<TestRunnerPage />} />
          <Route path="/projects/:projectId/reports" element={<ReportsPage />} />
          <Route path="/projects/:projectId/jira" element={<JiraConfigPage />} />
          <Route path="/test-cases" element={<ProjectsPage />} />
          <Route path="/runner" element={<ProjectsPage />} />
          <Route path="/reports" element={<ProjectsPage />} />
          <Route path="/reports/:id" element={<ReportDetailPage />} />
          <Route path="/jira" element={<ProjectsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>

        {/* Default redirect */}
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
