import { Global, Inject, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from '@opensearch-project/opensearch';
import { OPENSEARCH_CLIENT } from './opensearch.constants';

@Global()
@Module({
  providers: [
    {
      provide: OPENSEARCH_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Client => {
        const node = config.get<string>('OPENSEARCH_NODE', 'http://localhost:9200');
        const username = config.get<string>('OPENSEARCH_USERNAME');
        const password = config.get<string>('OPENSEARCH_PASSWORD');

        Logger.log(`Connecting to OpenSearch at ${node}`, 'OpenSearchModule');
        return new Client({
          node,
          ...(username && password ? { auth: { username, password } } : {}),
          // Accept self-signed certs when the security plugin is enabled (dev only)
          ssl: { rejectUnauthorized: false },
        });
      },
    },
  ],
  exports: [OPENSEARCH_CLIENT],
})
export class OpenSearchModule implements OnApplicationShutdown {
  constructor(@Inject(OPENSEARCH_CLIENT) private readonly client: Client) {}

  async onApplicationShutdown() {
    await this.client.close();
  }
}
