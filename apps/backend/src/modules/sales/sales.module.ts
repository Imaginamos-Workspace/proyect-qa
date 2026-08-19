import { Module } from '@nestjs/common';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';
import { SalesRagService } from './sales-rag.service';
import { ProspectsService } from './prospects.service';
import { ProspectsCronController } from './prospects-cron.controller';
import { RateLimitService } from './rate-limit.service';
import { ScraperService } from './web/scraper.service';
import { WebProspectsService } from './web/web-prospects.service';
import { OpenDataService } from './web/opendata.service';
import { ApolloOrgsService } from './web/apollo-orgs.service';
import { ProspectContactsService } from './web/prospect-contacts.service';
import { AuthModule } from '../auth/auth.module';
import { AIModule } from '../ai/ai.module';
import { ScrumModule } from '../scrum/scrum.module';

@Module({
  imports: [AuthModule, AIModule, ScrumModule],
  controllers: [SalesController, ProspectsCronController],
  providers: [SalesService, SalesRagService, ProspectsService, RateLimitService, ScraperService, WebProspectsService, OpenDataService, ApolloOrgsService, ProspectContactsService],
})
export class SalesModule {}
