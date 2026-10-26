import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseArrayPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CreateProductDto } from './dto/create-product.dto';
import { SearchProductDto } from './dto/search-product.dto';
import { SuggestProductDto } from './dto/suggest-product.dto';
import { ReplaceProductDto, UpdateProductDto } from './dto/update-product.dto';
import { ProductsService } from './products.service';

@ApiTags('products')
@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a product' })
  create(@Body() dto: CreateProductDto) {
    return this.products.create(dto);
  }

  @Post('bulk')
  @ApiOperation({ summary: 'Create (or overwrite) many products in one request' })
  @ApiBody({ type: [CreateProductDto] })
  bulkCreate(
    @Body(new ParseArrayPipe({ items: CreateProductDto, whitelist: true, forbidNonWhitelisted: true }))
    dtos: CreateProductDto[],
  ) {
    return this.products.bulkCreate(dtos);
  }

  @Get('search')
  @ApiOperation({ summary: 'Full-text search with filters, sorting, pagination and facets' })
  search(@Query() query: SearchProductDto) {
    return this.products.search(query);
  }

  @Get('suggest')
  @ApiOperation({ summary: 'Autocomplete product names while the user types' })
  suggest(@Query() query: SuggestProductDto) {
    return this.products.suggest(query.q, query.size);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Catalog statistics computed with aggregations' })
  stats() {
    return this.products.stats();
  }

  // Parameterised routes must come after the fixed ones above, otherwise
  // GET /products/stats would be handled as GET /products/:id with id = "stats".
  @Get(':id')
  @ApiOperation({ summary: 'Get a product by id' })
  findOne(@Param('id') id: string) {
    return this.products.findOne(id);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Replace a product (all fields required)' })
  replace(@Param('id') id: string, @Body() dto: ReplaceProductDto) {
    return this.products.replace(id, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Edit a product (only the fields you send are changed)' })
  update(@Param('id') id: string, @Body() dto: UpdateProductDto) {
    return this.products.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Delete a product' })
  remove(@Param('id') id: string) {
    return this.products.remove(id);
  }
}
