import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthController } from './health.controller';
import { AuthModule } from './modules/auth/auth.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { TestSuitesModule } from './modules/test-suites/test-suites.module';
import { TestCasesModule } from './modules/test-cases/test-cases.module';
import { TestRunsModule } from './modules/test-runs/test-runs.module';
import { ReportsModule } from './modules/reports/reports.module';
import { JiraModule } from './modules/jira/jira.module';
import { AIModule } from './modules/ai/ai.module';
import { ModulesModule } from './modules/modules/modules.module';
import { IngestModule } from './modules/ingest/ingest.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { ScrumModule } from './modules/scrum/scrum.module';
import { RegressionModule } from './modules/regression/regression.module';
import { SalesModule } from './modules/sales/sales.module';
import { SupabaseModule } from './config/supabase.module';

@Module({
  controllers: [HealthController],
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    SupabaseModule,
    AuthModule,
    ProjectsModule,
    TestSuitesModule,
    TestCasesModule,
    TestRunsModule,
    ReportsModule,
    JiraModule,
    AIModule,
    ModulesModule,
    IngestModule,
    DashboardModule,
    ScrumModule,
    RegressionModule,
    SalesModule,
  ],
})
export class AppModule {}
