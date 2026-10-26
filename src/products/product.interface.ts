export interface Product {
  id: string;
  name: string;
  description?: string;
  category: string;
  tags?: string[];
  price: number;
  stock: number;
  inStock: boolean;
  createdAt: string;
  updatedAt: string;
}
