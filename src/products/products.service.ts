import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from '@opensearch-project/opensearch';
import { randomUUID } from 'crypto';
import { OPENSEARCH_CLIENT } from '../opensearch/opensearch.constants';
import { CreateProductDto } from './dto/create-product.dto';
import { SearchProductDto } from './dto/search-product.dto';
import { ReplaceProductDto, UpdateProductDto } from './dto/update-product.dto';
import { Product } from './product.interface';
import { PRODUCTS_INDEX_BODY } from './products.mapping';

const SORT_FIELDS = { price: 'price', createdAt: 'createdAt', name: 'name.keyword' } as const;

@Injectable()
export class ProductsService implements OnModuleInit {
  private readonly logger = new Logger(ProductsService.name);
  private readonly index: string;

  constructor(
    @Inject(OPENSEARCH_CLIENT) private readonly client: Client,
    config: ConfigService,
  ) {
    this.index = config.get<string>('OPENSEARCH_INDEX', 'products');
  }

  /** Waits for OpenSearch to be reachable, then creates the index (with mapping) if missing. */
  async onModuleInit() {
    for (let attempt = 1; attempt <= 30; attempt++) {
      try {
        const { body: exists } = await this.client.indices.exists({ index: this.index });
        if (!exists) {
          await this.client.indices.create({ index: this.index, body: PRODUCTS_INDEX_BODY });
          this.logger.log(`Created index "${this.index}"`);
        } else {
          this.logger.log(`Index "${this.index}" already exists`);
          await this.addMissingAutocompleteField();
        }
        return;
      } catch (err) {
        this.logger.warn(`OpenSearch not ready (attempt ${attempt}/30): ${(err as Error).message}`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    throw new Error('Could not connect to OpenSearch');
  }

  /**
   * Mapping migration for indices created before autocomplete existed.
   * Adding a new sub-field to an existing field is allowed; changing a field's type is not.
   * Documents indexed earlier don't have the new sub-field until they are re-indexed,
   * so an empty _update_by_query rewrites them in place.
   */
  private async addMissingAutocompleteField() {
    const { body } = await this.client.indices.getMapping({ index: this.index });
    const nameField = (Object.values(body)[0] as any).mappings.properties?.name;
    if (nameField?.fields?.autocomplete) return;

    await this.client.indices.putMapping({
      index: this.index,
      body: { properties: { name: PRODUCTS_INDEX_BODY.mappings.properties.name } },
    });
    await this.client.updateByQuery({ index: this.index, conflicts: 'proceed', refresh: true });
    this.logger.log(`Added name.autocomplete to "${this.index}" and re-indexed existing documents`);
  }

  async create(dto: CreateProductDto): Promise<Product> {
    const { id = randomUUID(), ...fields } = dto;
    const now = new Date().toISOString();
    const doc = { ...fields, inStock: fields.stock > 0, createdAt: now, updatedAt: now };

    try {
      // `create` fails with 409 if the id already exists (unlike `index`, which overwrites)
      await this.client.create({ index: this.index, id, body: doc, refresh: 'wait_for' });
    } catch (err) {
      if (statusOf(err) === 409) throw new ConflictException(`Product "${id}" already exists`);
      throw err;
    }
    return { id, ...doc };
  }

  async bulkCreate(dtos: CreateProductDto[]) {
    const now = new Date().toISOString();
    const body = dtos.flatMap(({ id = randomUUID(), ...fields }) => [
      { index: { _index: this.index, _id: id } },
      { ...fields, inStock: fields.stock > 0, createdAt: now, updatedAt: now },
    ]);
    const { body: res } = await this.client.bulk({ body, refresh: 'wait_for' });
    return {
      errors: res.errors,
      items: res.items.map((i: any) => ({
        id: i.index._id,
        result: i.index.result,
        error: i.index.error?.reason,
      })),
    };
  }

  async findOne(id: string): Promise<Product> {
    try {
      const { body } = await this.client.get({ index: this.index, id });
      return { id: body._id, ...(body._source as Omit<Product, 'id'>) };
    } catch (err) {
      if (statusOf(err) === 404) throw new NotFoundException(`Product "${id}" not found`);
      throw err;
    }
  }

  /**
   * Product search: full text + filters + sort + pagination + facets.
   *
   * Filters are split in two groups:
   *  - `query` filters (q, price, inStock) narrow both the hits AND every facet.
   *  - "facet" filters (category, tags) go in `post_filter`, which narrows only the hits.
   *    Each facet aggregation re-applies the *other* facet filters itself, so the
   *    category list still shows every category while one is selected (multi-select facets).
   *
   * Pagination: `page`/`size` (from + size) for normal UIs, or `cursor` (search_after)
   * for infinite scroll / deep paging. `_id` is always the last sort key so the order
   * is stable and the cursor is unique.
   */
  async search(dto: SearchProductDto) {
    const must: any[] = [];
    const filter: any[] = [];

    if (dto.q) {
      must.push({
        multi_match: {
          query: dto.q,
          fields: ['name^3', 'description', 'tags^2'],
          fuzziness: 'AUTO',
        },
      });
    }
    if (dto.inStock !== undefined) filter.push({ term: { inStock: dto.inStock } });
    if (dto.minPrice !== undefined || dto.maxPrice !== undefined) {
      filter.push({ range: { price: { gte: dto.minPrice, lte: dto.maxPrice } } });
    }

    const categoryFilter = dto.category ? { term: { category: dto.category } } : undefined;
    const tagsFilter = dto.tags
      ? { terms: { tags: dto.tags.split(',').map((t) => t.trim()) } }
      : undefined;
    const facetFilters = [categoryFilter, tagsFilter].filter(Boolean);
    const allOf = (clauses: any[]) => (clauses.length ? { bool: { filter: clauses } } : { match_all: {} });

    const sortField = dto.sortBy === 'relevance' ? '_score' : SORT_FIELDS[dto.sortBy];
    const sort = [
      sortField === '_score' ? { _score: { order: 'desc' } } : { [sortField]: { order: dto.order } },
      { _id: { order: 'asc' } }, // tie-breaker: stable order + unique search_after cursor
    ];
    const searchAfter = dto.cursor ? decodeCursor(dto.cursor) : undefined;

    const { body } = await this.client.search({
      index: this.index,
      body: {
        ...(searchAfter ? { search_after: searchAfter } : { from: (dto.page - 1) * dto.size }),
        size: dto.size,
        track_total_hits: true,
        query: must.length || filter.length ? { bool: { must, filter } } : { match_all: {} },
        ...(facetFilters.length ? { post_filter: allOf(facetFilters) } : {}),
        sort,
        ...(dto.q ? { highlight: { fields: { name: {}, description: {} } } } : {}),
        aggs: {
          categories: {
            filter: allOf([tagsFilter].filter(Boolean)),
            aggs: { values: { terms: { field: 'category', size: 50 } } },
          },
          tags: {
            filter: allOf([categoryFilter].filter(Boolean)),
            aggs: { values: { terms: { field: 'tags', size: 50 } } },
          },
          price: {
            filter: allOf(facetFilters),
            aggs: { stats: { stats: { field: 'price' } } },
          },
        },
      },
    });

    const total = typeof body.hits.total === 'number' ? body.hits.total : body.hits.total.value;
    const hits = body.hits.hits as any[];
    const aggs = body.aggregations as any;
    const last = hits[hits.length - 1];
    return {
      total,
      page: searchAfter ? undefined : dto.page,
      size: dto.size,
      totalPages: Math.ceil(total / dto.size),
      nextCursor: hits.length === dto.size && last ? encodeCursor(last.sort) : null,
      items: hits.map((h) => ({
        id: h._id,
        score: h._score,
        ...h._source,
        ...(h.highlight ? { highlight: h.highlight } : {}),
      })),
      facets: {
        categories: aggs.categories.values.buckets.map((b: any) => ({ category: b.key, count: b.doc_count })),
        tags: aggs.tags.values.buckets.map((b: any) => ({ tag: b.key, count: b.doc_count })),
        price: aggs.price.stats,
      },
    };
  }

  /** Autocomplete: product names that start with what the user has typed so far. */
  async suggest(q: string, size: number) {
    const { body } = await this.client.search({
      index: this.index,
      body: {
        size,
        _source: ['name', 'category', 'price'],
        query: {
          multi_match: {
            query: q,
            type: 'bool_prefix',
            fields: ['name.autocomplete', 'name.autocomplete._2gram', 'name.autocomplete._3gram'],
          },
        },
      },
    });
    return (body.hits.hits as any[]).map((h) => ({ id: h._id, ...h._source }));
  }

  /** Dashboard numbers computed with aggregations (no documents returned: size 0). */
  async stats() {
    const { body } = await this.client.search({
      index: this.index,
      body: {
        size: 0,
        track_total_hits: true,
        aggs: {
          // Keep date_histogram BEFORE range: OpenSearch 2.19.1 throws
          // "array_index_out_of_bounds_exception" when a top-level range aggregation
          // precedes a date_histogram (bug in its agg filter-rewrite optimisation).
          created_per_month: {
            date_histogram: { field: 'createdAt', calendar_interval: 'month', format: 'yyyy-MM' },
          },
          by_category: {
            terms: { field: 'category', size: 50 },
            aggs: {
              avg_price: { avg: { field: 'price' } },
              units_in_stock: { sum: { field: 'stock' } },
              out_of_stock: { filter: { term: { inStock: false } } },
            },
          },
          price_ranges: {
            range: {
              field: 'price',
              ranges: [
                { key: 'under 25', to: 25 },
                { key: '25 to 100', from: 25, to: 100 },
                { key: '100 and above', from: 100 },
              ],
            },
          },
          top_tags: { terms: { field: 'tags', size: 10 } },
          price_stats: { stats: { field: 'price' } },
          // Scripts must handle documents where a field is missing (doc[...].size() == 0)
          inventory_value: {
            sum: {
              script: {
                source:
                  "doc['price'].size() == 0 || doc['stock'].size() == 0 ? 0 : doc['price'].value * doc['stock'].value",
              },
            },
          },
          out_of_stock: { filter: { term: { inStock: false } } },
        },
      },
    });

    const a = body.aggregations as any;
    const round = (n: number | null) => (n == null ? null : Math.round(n * 100) / 100);
    return {
      totalProducts: typeof body.hits.total === 'number' ? body.hits.total : body.hits.total.value,
      outOfStock: a.out_of_stock.doc_count,
      inventoryValue: round(a.inventory_value.value),
      price: {
        min: round(a.price_stats.min),
        max: round(a.price_stats.max),
        avg: round(a.price_stats.avg),
      },
      byCategory: a.by_category.buckets.map((b: any) => ({
        category: b.key,
        products: b.doc_count,
        avgPrice: round(b.avg_price.value),
        unitsInStock: b.units_in_stock.value,
        outOfStock: b.out_of_stock.doc_count,
      })),
      priceRanges: a.price_ranges.buckets.map((b: any) => ({ range: b.key, products: b.doc_count })),
      createdPerMonth: a.created_per_month.buckets.map((b: any) => ({ month: b.key_as_string, products: b.doc_count })),
      topTags: a.top_tags.buckets.map((b: any) => ({ tag: b.key, products: b.doc_count })),
    };
  }

  /** PUT: replaces the whole document (keeps createdAt). */
  async replace(id: string, dto: ReplaceProductDto): Promise<Product> {
    const existing = await this.findOne(id);
    const doc = {
      ...dto,
      inStock: dto.stock > 0,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };
    await this.client.index({ index: this.index, id, body: doc, refresh: 'wait_for' });
    return { id, ...doc };
  }

  /** PATCH: merges only the given fields into the existing document. */
  async update(id: string, dto: UpdateProductDto): Promise<Product> {
    const partial: Record<string, unknown> = { ...dto, updatedAt: new Date().toISOString() };
    if (dto.stock !== undefined) partial.inStock = dto.stock > 0;

    try {
      const { body } = await this.client.update({
        index: this.index,
        id,
        body: { doc: partial },
        refresh: 'wait_for',
        _source: 'true', // return the updated document in the response
      });
      return { id, ...((body as any).get._source as Omit<Product, 'id'>) };
    } catch (err) {
      if (statusOf(err) === 404) throw new NotFoundException(`Product "${id}" not found`);
      throw err;
    }
  }

  async remove(id: string) {
    try {
      await this.client.delete({ index: this.index, id, refresh: 'wait_for' });
      return { id, deleted: true };
    } catch (err) {
      if (statusOf(err) === 404) throw new NotFoundException(`Product "${id}" not found`);
      throw err;
    }
  }
}

function statusOf(err: unknown): number | undefined {
  return (err as { meta?: { statusCode?: number } })?.meta?.statusCode;
}

/** The cursor is the `sort` array of the last hit, base64url-encoded so it is URL safe. */
function encodeCursor(sortValues: unknown[]): string {
  return Buffer.from(JSON.stringify(sortValues)).toString('base64url');
}

function decodeCursor(cursor: string): unknown[] {
  try {
    const values = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(values)) return values;
  } catch {
    // fall through
  }
  throw new BadRequestException('Invalid cursor');
}
