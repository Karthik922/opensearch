import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Client } from '@opensearch-project/opensearch';
import { OPENSEARCH_CLIENT } from '../opensearch/opensearch.constants';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(@Inject(OPENSEARCH_CLIENT) private readonly client: Client) {}

  @Get()
  @ApiOperation({ summary: 'API and OpenSearch cluster health' })
  async check() {
    const { body } = await this.client.cluster.health();
    return { api: 'ok', opensearch: { cluster: body.cluster_name, status: body.status } };
  }
}
