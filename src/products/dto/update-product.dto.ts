import { OmitType, PartialType } from '@nestjs/swagger';
import { CreateProductDto } from './create-product.dto';

/** PUT body: every field required (full replacement). The id comes from the URL. */
export class ReplaceProductDto extends OmitType(CreateProductDto, ['id'] as const) {}

/** PATCH body: any subset of fields (partial edit). */
export class UpdateProductDto extends PartialType(ReplaceProductDto) {}
