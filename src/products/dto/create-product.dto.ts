import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class CreateProductDto {
  @ApiPropertyOptional({ description: 'Custom id. Auto-generated (UUID) when omitted.', example: 'p-1001' })
  @IsOptional()
  @IsString()
  id?: string;

  @ApiProperty({ example: 'Wireless Mouse' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional({ example: 'Ergonomic 2.4GHz wireless mouse with silent clicks' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ example: 'electronics' })
  @IsString()
  @IsNotEmpty()
  category: string;

  @ApiPropertyOptional({ example: ['computer', 'accessories'], type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiProperty({ example: 19.99 })
  @IsNumber()
  @Min(0)
  price: number;

  @ApiProperty({ example: 150 })
  @IsInt()
  @Min(0)
  stock: number;
}
