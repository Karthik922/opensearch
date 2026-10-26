import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthController } from './health/health.controller';
import { OpenSearchModule } from './opensearch/opensearch.module';
import { ProductsModule } from './products/products.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), OpenSearchModule, ProductsModule],
  controllers: [HealthController],
})
export class AppModule {}
