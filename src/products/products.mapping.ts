/** Index settings + field mapping for the products index. */
export const PRODUCTS_INDEX_BODY = {
  settings: {
    number_of_shards: 1,
    number_of_replicas: 0,
  },
  mappings: {
    properties: {
      name: {
        type: 'text',
        fields: {
          keyword: { type: 'keyword' }, // exact value: sorting, aggregations
          autocomplete: { type: 'search_as_you_type' }, // prefix matching for /products/suggest
        },
      },
      description: { type: 'text' },
      category: { type: 'keyword' },
      tags: { type: 'keyword' },
      price: { type: 'float' },
      stock: { type: 'integer' },
      inStock: { type: 'boolean' },
      createdAt: { type: 'date' },
      updatedAt: { type: 'date' },
    },
  },
};
