import {
  BOMComponent,
  BOMExplosionNode,
  ExplodedMaterialItem,
  ExplosionResult,
  ItemType,
  MeasurementUnit,
  Recipe,
  RecipeSchema,
  areUnitsCompatible,
  convertUnit,
} from './types';

export interface ExplodeOptions {
  includeWaste?: boolean;      // Tính cả tỷ lệ hao hụt khi pha/nấu (mặc định: true)
  roundDecimals?: number;      // Làm tròn số thập phân (mặc định: 2)
  maxDepth?: number;           // Giới hạn độ sâu đệ quy chống vòng lặp vô hạn (mặc định: 10)
}

/**
 * Quản lý danh mục công thức định lượng (Recipe Catalog)
 */
export class RecipeCatalog {
  private recipes: Map<string, Recipe> = new Map();

  constructor(initialRecipes: Recipe[] = []) {
    for (const r of initialRecipes) {
      this.registerRecipe(r);
    }
  }

  registerRecipe(recipe: Recipe): void {
    const validated = RecipeSchema.parse(recipe);
    this.recipes.set(validated.id, validated);
  }

  getRecipe(id: string): Recipe | undefined {
    return this.recipes.get(id);
  }

  getAllRecipes(): Recipe[] {
    return Array.from(this.recipes.values());
  }

  getRecipesByType(type: 'FINISHED_PRODUCT' | 'SEMI_FINISHED'): Recipe[] {
    return this.getAllRecipes().filter((r) => r.type === type);
  }

  getRecipesByCategory(category: string): Recipe[] {
    return this.getAllRecipes().filter(
      (r) => r.category.toLowerCase() === category.toLowerCase()
    );
  }

  hasRecipe(id: string): boolean {
    return this.recipes.has(id);
  }
}

/**
 * Phân rã công thức BOM đa cấp (Multi-level BOM Explosion)
 * @param recipeId Mã công thức thành phẩm
 * @param quantity Số lượng thành phẩm cần sản xuất/bán ra
 * @param catalog Kho danh mục công thức
 * @param options Tùy chọn phân rã (tính hao hụt, làm tròn)
 */
export function explodeBOM(
  recipeId: string,
  quantity: number,
  catalog: RecipeCatalog | Map<string, Recipe> | Recipe[],
  options: ExplodeOptions = {}
): ExplosionResult {
  const { includeWaste = true, roundDecimals = 2, maxDepth = 10 } = options;

  if (quantity <= 0) {
    throw new Error(`Số lượng thành phẩm phải lớn hơn 0 (nhận được: ${quantity})`);
  }

  // Chuẩn hóa catalog
  const catalogMap: Map<string, Recipe> =
    catalog instanceof RecipeCatalog
      ? new Map(catalog.getAllRecipes().map((r) => [r.id, r]))
      : catalog instanceof Map
      ? catalog
      : new Map(catalog.map((r) => [r.id, r]));

  const rootRecipe = catalogMap.get(recipeId);
  if (!rootRecipe) {
    throw new Error(`Không tìm thấy công thức định lượng với mã: ${recipeId}`);
  }

  // Bản đồ lưu trữ nguyên liệu gộp
  const aggregatedMap = new Map<
    string,
    {
      itemId: string;
      name: string;
      type: ItemType;
      unit: MeasurementUnit;
      unitCost: number;
      totalQuantity: number;
      wasteQuantity: number;
      sourceLevel: number;
      parentRecipes: Set<string>;
    }
  >();

  // Ngăn chặn chu trình đệ quy vô hạn
  const visitedPath = new Set<string>();

  // Hàm đệ quy duyệt cây BOM
  function traverse(
    currRecipe: Recipe,
    multiplier: number,
    depth: number,
    parentName?: string
  ): BOMExplosionNode {
    if (depth > maxDepth) {
      throw new Error(
        `Vượt quá độ sâu phân rã BOM tối đa (${maxDepth}). Nghi vấn có vòng lặp phụ thuộc trong công thức ${currRecipe.id}`
      );
    }

    if (visitedPath.has(currRecipe.id)) {
      throw new Error(
        `Phát hiện vòng lặp đệ quy trong BOM tại công thức: ${currRecipe.id} (${currRecipe.name})`
      );
    }

    visitedPath.add(currRecipe.id);

    const node: BOMExplosionNode = {
      recipeId: currRecipe.id,
      recipeName: currRecipe.name,
      quantity: multiplier,
      unit: currRecipe.unit || 'pcs',
      level: depth,
      components: [],
    };

    // Tỷ lệ so với yieldQuantity của công thức
    const scaleFactor = multiplier / (currRecipe.yieldQuantity || 1);

    for (const comp of currRecipe.components) {
      let requiredQty = comp.quantity * scaleFactor;
      let wasteQty = 0;

      const wastePct = comp.wastePercent || 0;
      if (includeWaste && wastePct > 0) {
        wasteQty = requiredQty * (wastePct / 100);
        requiredQty += wasteQty;
      }

      let subTree: BOMExplosionNode | undefined = undefined;

      // Nếu là bán thành phẩm có công thức cấp con (Sub-recipe)
      if (comp.isSubRecipe && comp.subRecipeId && catalogMap.has(comp.subRecipeId)) {
        const subRecipe = catalogMap.get(comp.subRecipeId)!;
        subTree = traverse(subRecipe, requiredQty, depth + 1, currRecipe.name);
      } else {
        // Là nguyên liệu thô hoặc bao bì đóng gói trực tiếp
        const existing = aggregatedMap.get(comp.itemId);
        if (existing) {
          // Kiểm tra tương thích đơn vị nếu có khác biệt
          let additionalQty = requiredQty;
          let additionalWaste = wasteQty;
          if (comp.unit !== existing.unit) {
            if (areUnitsCompatible(comp.unit, existing.unit)) {
              additionalQty = convertUnit(requiredQty, comp.unit, existing.unit);
              additionalWaste = convertUnit(wasteQty, comp.unit, existing.unit);
            }
          }
          existing.totalQuantity += additionalQty;
          existing.wasteQuantity += additionalWaste;
          if (parentName) existing.parentRecipes.add(parentName);
          existing.parentRecipes.add(currRecipe.name);
          existing.sourceLevel = Math.min(existing.sourceLevel, depth);
        } else {
          aggregatedMap.set(comp.itemId, {
            itemId: comp.itemId,
            name: comp.name,
            type: comp.type,
            unit: comp.unit,
            unitCost: comp.unitCost || 0,
            totalQuantity: requiredQty,
            wasteQuantity: wasteQty,
            sourceLevel: depth,
            parentRecipes: new Set(parentName ? [parentName, currRecipe.name] : [currRecipe.name]),
          });
        }
      }

      node.components.push({
        component: comp,
        requiredQuantity: Number(requiredQty.toFixed(roundDecimals)),
        unit: comp.unit,
        subTree,
      });
    }

    visitedPath.delete(currRecipe.id);
    return node;
  }

  const hierarchyTree = traverse(rootRecipe, quantity, 1);

  // Chuyển map thành danh sách phân loại
  const round = (val: number) => Number(val.toFixed(roundDecimals));

  const allMaterials: ExplodedMaterialItem[] = Array.from(aggregatedMap.values()).map(
    (item) => ({
      itemId: item.itemId,
      name: item.name,
      type: item.type,
      totalQuantity: round(item.totalQuantity),
      unit: item.unit,
      unitCost: item.unitCost,
      totalCost: round(item.totalQuantity * item.unitCost),
      wasteQuantity: round(item.wasteQuantity),
      sourceLevel: item.sourceLevel,
      parentRecipeNames: Array.from(item.parentRecipes),
    })
  );

  const rawMaterials = allMaterials.filter((m) => m.type === 'RAW_MATERIAL');
  const packaging = allMaterials.filter((m) => m.type === 'PACKAGING');
  const semiFinished = allMaterials.filter((m) => m.type === 'SEMI_FINISHED');

  const totalCost = round(
    allMaterials.reduce((sum, item) => sum + item.totalCost, 0)
  );

  return {
    recipeId: rootRecipe.id,
    recipeName: rootRecipe.name,
    quantity,
    rawMaterials,
    packaging,
    semiFinished,
    allMaterials,
    totalCost,
    hierarchyTree,
  };
}

/**
 * Phân rã theo lô nhiều món (Batch POS Sales Explosion)
 * Giả lập bán 50-100 ly nước tại quầy POS chi nhánh và tính tổng nguyên liệu trừ kho
 */
export function explodeBatch(
  orderItems: Array<{ recipeId: string; quantity: number }>,
  catalog: RecipeCatalog | Map<string, Recipe> | Recipe[],
  options: ExplodeOptions = {}
): {
  totalOrders: number;
  totalQuantity: number;
  totalCost: number;
  aggregatedMaterials: ExplodedMaterialItem[];
  perRecipeResults: ExplosionResult[];
} {
  const perRecipeResults: ExplosionResult[] = [];
  const aggregatedMap = new Map<string, ExplodedMaterialItem>();

  let totalQty = 0;
  let totalCost = 0;

  for (const item of orderItems) {
    if (item.quantity <= 0) continue;
    const result = explodeBOM(item.recipeId, item.quantity, catalog, options);
    perRecipeResults.push(result);
    totalQty += item.quantity;
    totalCost += result.totalCost;

    for (const mat of result.allMaterials) {
      const existing = aggregatedMap.get(mat.itemId);
      if (existing) {
        existing.totalQuantity = Number(
          (existing.totalQuantity + mat.totalQuantity).toFixed(2)
        );
        existing.wasteQuantity = Number(
          (existing.wasteQuantity + mat.wasteQuantity).toFixed(2)
        );
        existing.totalCost = Number((existing.totalCost + mat.totalCost).toFixed(2));
        for (const p of mat.parentRecipeNames) {
          if (!existing.parentRecipeNames.includes(p)) {
            existing.parentRecipeNames.push(p);
          }
        }
      } else {
        aggregatedMap.set(mat.itemId, { ...mat });
      }
    }
  }

  return {
    totalOrders: orderItems.length,
    totalQuantity: totalQty,
    totalCost: Number(totalCost.toFixed(2)),
    aggregatedMaterials: Array.from(aggregatedMap.values()).sort((a, b) =>
      a.name.localeCompare(b.name, 'vi')
    ),
    perRecipeResults,
  };
}

/**
 * Tính giá thành vốn (Cost of Goods Sold - COGS) cho 1 đơn vị thành phẩm
 */
export function calculateRecipeCost(
  recipeId: string,
  catalog: RecipeCatalog | Map<string, Recipe> | Recipe[]
): number {
  const result = explodeBOM(recipeId, 1, catalog, { includeWaste: true });
  return result.totalCost;
}

// ============================================================================
// Dữ liệu mẫu chuẩn 10 Công thức Đồ uống & Bán thành phẩm F&B Việt Nam
// ============================================================================

export const DEFAULT_FNB_RECIPES: Recipe[] = [
  // --- BÁN THÀNH PHẨM (SEMI-FINISHED) CỦA BẾP TỔNG ---
  {
    id: 'SUB-KEM-MUOI',
    sku: 'BTP-KM-500',
    name: 'Kem Muối Biển Bếp Tổng (Hộp 500ml)',
    category: 'Bán Thành Phẩm Bếp Tổng',
    type: 'SEMI_FINISHED',
    yieldQuantity: 500, // 500ml
    unit: 'ml',
    costPrice: 42000,
    shelfLifeHours: 48,
    components: [
      {
        itemId: 'NL-WHIP-CREAM',
        name: 'Whipping Cream Anchor',
        type: 'RAW_MATERIAL',
        quantity: 350,
        unit: 'ml',
        wastePercent: 2,
        unitCost: 110, // 110k/1000ml -> 110đ/ml
      },
      {
        itemId: 'NL-SUA-TUOI-TT',
        name: 'Sữa Tươi Thanh Trùng Dalat Milk',
        type: 'RAW_MATERIAL',
        quantity: 150,
        unit: 'ml',
        wastePercent: 1,
        unitCost: 38, // 38k/1000ml -> 38đ/ml
      },
      {
        itemId: 'NL-MUOI-HIMALAYA',
        name: 'Muối Hồng Himalaya Tinh Khiết',
        type: 'RAW_MATERIAL',
        quantity: 5,
        unit: 'g',
        wastePercent: 0,
        unitCost: 80, // 80đ/g
      },
    ],
  },
  {
    id: 'SUB-KEM-TRUNG',
    sku: 'BTP-KT-500',
    name: 'Kem Trứng Nướng Bếp Tổng (Hộp 500ml)',
    category: 'Bán Thành Phẩm Bếp Tổng',
    type: 'SEMI_FINISHED',
    yieldQuantity: 500,
    unit: 'ml',
    costPrice: 48000,
    shelfLifeHours: 36,
    components: [
      {
        itemId: 'NL-TRUNG-GA',
        name: 'Lòng Đỏ Trứng Gà CP Chuẩn Khử Trùng',
        type: 'RAW_MATERIAL',
        quantity: 6,
        unit: 'pcs',
        wastePercent: 0,
        unitCost: 3200, // 3.2k/quả
      },
      {
        itemId: 'NL-WHIP-CREAM',
        name: 'Whipping Cream Anchor',
        type: 'RAW_MATERIAL',
        quantity: 250,
        unit: 'ml',
        wastePercent: 2,
        unitCost: 110,
      },
      {
        itemId: 'NL-SUA-DAC',
        name: 'Sữa Đặc Ngôi Sao Phương Nam',
        type: 'RAW_MATERIAL',
        quantity: 80,
        unit: 'ml',
        wastePercent: 2,
        unitCost: 55,
      },
      {
        itemId: 'NL-VANILLA',
        name: 'Hương Vanilla Pháp Rayner',
        type: 'RAW_MATERIAL',
        quantity: 5,
        unit: 'ml',
        wastePercent: 0,
        unitCost: 300,
      },
    ],
  },
  {
    id: 'SUB-TRAN-CHAU-HK',
    sku: 'BTP-TCHK-1000',
    name: 'Trân Châu Hoàng Kim Nấu Sẵn (Mẻ 1000g)',
    category: 'Bán Thành Phẩm Bếp Tổng',
    type: 'SEMI_FINISHED',
    yieldQuantity: 1000, // 1000g trân châu chín
    unit: 'g',
    costPrice: 32000,
    shelfLifeHours: 8,
    components: [
      {
        itemId: 'NL-HAT-TC-KHO',
        name: 'Hạt Trân Châu Sợi Hoàng Kim Khô',
        type: 'RAW_MATERIAL',
        quantity: 500,
        unit: 'g',
        wastePercent: 3,
        unitCost: 45, // 45k/kg
      },
      {
        itemId: 'NL-DUONG-DEN',
        name: 'Đường Đen Hàn Quốc Beksul',
        type: 'RAW_MATERIAL',
        quantity: 120,
        unit: 'g',
        wastePercent: 1,
        unitCost: 60,
      },
      {
        itemId: 'NL-MAT-MIA',
        name: 'Mật Mía Nghệ An Nguyên Chất',
        type: 'RAW_MATERIAL',
        quantity: 50,
        unit: 'ml',
        wastePercent: 2,
        unitCost: 50,
      },
      {
        itemId: 'NL-NUOC-LOC',
        name: 'Nước Lọc RO Nấu Trân Châu',
        type: 'RAW_MATERIAL',
        quantity: 2000,
        unit: 'ml',
        wastePercent: 0,
        unitCost: 1,
      },
    ],
  },
  {
    id: 'SUB-NUOC-DUONG',
    sku: 'BTP-ND-1000',
    name: 'Nước Đường Tỷ Lệ Chuẩn 1:1 (Chai 1000ml)',
    category: 'Bán Thành Phẩm Bếp Tổng',
    type: 'SEMI_FINISHED',
    yieldQuantity: 1000,
    unit: 'ml',
    costPrice: 22000,
    shelfLifeHours: 720,
    components: [
      {
        itemId: 'NL-DUONG-CAT',
        name: 'Đường Cát Trắng Tinh Luyện Biên Hòa',
        type: 'RAW_MATERIAL',
        quantity: 700,
        unit: 'g',
        wastePercent: 1,
        unitCost: 26, // 26k/kg
      },
      {
        itemId: 'NL-NUOC-LOC',
        name: 'Nước Lọc RO Nấu Đường',
        type: 'RAW_MATERIAL',
        quantity: 700,
        unit: 'ml',
        wastePercent: 0,
        unitCost: 1,
      },
    ],
  },

  // --- 10 CÔNG THỨC ĐỒ UỐNG CHUẨN ĐỊNH LƯỢNG (FINISHED PRODUCTS) ---

  // 1. Trà Đào Cam Sả
  {
    id: 'RECIPE-TRA-DAO-CAM-SA',
    sku: 'DRK-TDCS-500',
    name: 'Trà Đào Cam Sả Tươi (Size L 500ml)',
    category: 'Trà Hoa Quả',
    type: 'FINISHED_PRODUCT',
    yieldQuantity: 1,
    unit: 'pcs',
    sellingPrice: 45000,
    components: [
      {
        itemId: 'NL-TRA-LAI-KHO',
        name: 'Trà Lài Bảo Lộc Thượng Hạng',
        type: 'RAW_MATERIAL',
        quantity: 15,
        unit: 'g',
        wastePercent: 4,
        unitCost: 280, // 280k/kg -> 280đ/g
      },
      {
        itemId: 'NL-SIRO-DAO',
        name: 'Siro Đào Monin Peach Syrup',
        type: 'RAW_MATERIAL',
        quantity: 30,
        unit: 'ml',
        wastePercent: 2,
        unitCost: 350, // 350k/1000ml -> 350đ/ml
      },
      {
        itemId: 'NL-DAO-NGAM',
        name: 'Miếng Đào Ngâm Kronos Giòn',
        type: 'RAW_MATERIAL',
        quantity: 3,
        unit: 'pcs',
        wastePercent: 0,
        unitCost: 2000, // 2k/miếng
      },
      {
        itemId: 'NL-COT-SA-TUOI',
        name: 'Nước Cốt Sả Đập Dập',
        type: 'RAW_MATERIAL',
        quantity: 10,
        unit: 'ml',
        wastePercent: 5,
        unitCost: 80,
      },
      {
        itemId: 'NL-CAM-VANG',
        name: 'Cam Vàng Navel Cắt Lát',
        type: 'RAW_MATERIAL',
        quantity: 1,
        unit: 'pcs',
        wastePercent: 5,
        unitCost: 1500,
      },
      // Sub-recipe nước đường
      {
        itemId: 'SUB-NUOC-DUONG',
        name: 'Nước Đường Tỷ Lệ Chuẩn 1:1',
        type: 'SEMI_FINISHED',
        quantity: 25,
        unit: 'ml',
        isSubRecipe: true,
        subRecipeId: 'SUB-NUOC-DUONG',
        unitCost: 22,
      },
      // Bao bì
      {
        itemId: 'BB-LY-PP-500',
        name: 'Ly Nhựa PP 500ml Chống Nóng',
        type: 'PACKAGING',
        quantity: 1,
        unit: 'pcs',
        wastePercent: 1,
        unitCost: 650,
      },
      {
        itemId: 'BB-NAP-KIM-CUONG',
        name: 'Nắp Cầu Kim Cương Phi 95',
        type: 'PACKAGING',
        quantity: 1,
        unit: 'pcs',
        wastePercent: 1,
        unitCost: 250,
      },
      {
        itemId: 'BB-ONG-HUT-BOC-MANG',
        name: 'Ống Hút Nhọn Phi 8 Bọc Màng OPP',
        type: 'PACKAGING',
        quantity: 1,
        unit: 'pcs',
        wastePercent: 0,
        unitCost: 150,
      },
    ],
  },

  // 2. Trà Sữa Trân Châu Hoàng Kim
  {
    id: 'RECIPE-TS-HOANG-KIM',
    sku: 'DRK-TSHK-500',
    name: 'Trà Sữa Trân Châu Hoàng Kim (Size L 500ml)',
    category: 'Trà Sữa',
    type: 'FINISHED_PRODUCT',
    yieldQuantity: 1,
    unit: 'pcs',
    sellingPrice: 48000,
    components: [
      {
        itemId: 'NL-TRA-DEN-OPA',
        name: 'Trà Đen Ceylon OPA Thơm Đậm',
        type: 'RAW_MATERIAL',
        quantity: 20,
        unit: 'g',
        wastePercent: 3,
        unitCost: 260,
      },
      {
        itemId: 'NL-BOT-SUA-BEO',
        name: 'Bột Sữa Béo Indo Kievit Vana Blanca',
        type: 'RAW_MATERIAL',
        quantity: 35,
        unit: 'g',
        wastePercent: 2,
        unitCost: 95,
      },
      {
        itemId: 'SUB-NUOC-DUONG',
        name: 'Nước Đường Tỷ Lệ Chuẩn 1:1',
        type: 'SEMI_FINISHED',
        quantity: 35,
        unit: 'ml',
        isSubRecipe: true,
        subRecipeId: 'SUB-NUOC-DUONG',
        unitCost: 22,
      },
      {
        itemId: 'SUB-TRAN-CHAU-HK',
        name: 'Trân Châu Hoàng Kim Nấu Sẵn',
        type: 'SEMI_FINISHED',
        quantity: 50,
        unit: 'g',
        isSubRecipe: true,
        subRecipeId: 'SUB-TRAN-CHAU-HK',
        unitCost: 32,
      },
      {
        itemId: 'BB-LY-PP-500',
        name: 'Ly Nhựa PP 500ml Chống Nóng',
        type: 'PACKAGING',
        quantity: 1,
        unit: 'pcs',
        unitCost: 650,
      },
      {
        itemId: 'BB-NAP-KIM-CUONG',
        name: 'Nắp Cầu Kim Cương Phi 95',
        type: 'PACKAGING',
        quantity: 1,
        unit: 'pcs',
        unitCost: 250,
      },
      {
        itemId: 'BB-ONG-HUT-TRAN-CHAU',
        name: 'Ống Hút Trân Châu Phi 12 Vát Nhọn',
        type: 'PACKAGING',
        quantity: 1,
        unit: 'pcs',
        unitCost: 180,
      },
    ],
  },

  // 3. Cà Phê Muối Xứ Huế
  {
    id: 'RECIPE-CF-MUOI',
    sku: 'DRK-CFM-350',
    name: 'Cà Phê Muối Xứ Huế Đặc Biệt (Size M 350ml)',
    category: 'Cà Phê Truyền Thống & Hiện Đại',
    type: 'FINISHED_PRODUCT',
    yieldQuantity: 1,
    unit: 'pcs',
    sellingPrice: 38000,
    components: [
      {
        itemId: 'NL-CA-PHE-ROBUSTA',
        name: 'Cà Phê Mộc Robusta Honey Đắk Lắk',
        type: 'RAW_MATERIAL',
        quantity: 25,
        unit: 'g',
        wastePercent: 2,
        unitCost: 220,
      },
      {
        itemId: 'NL-SUA-DAC',
        name: 'Sữa Đặc Ngôi Sao Phương Nam',
        type: 'RAW_MATERIAL',
        quantity: 25,
        unit: 'ml',
        wastePercent: 2,
        unitCost: 55,
      },
      {
        itemId: 'SUB-KEM-MUOI',
        name: 'Kem Muối Biển Bếp Tổng',
        type: 'SEMI_FINISHED',
        quantity: 30,
        unit: 'ml',
        isSubRecipe: true,
        subRecipeId: 'SUB-KEM-MUOI',
        unitCost: 84,
      },
      {
        itemId: 'BB-LY-PET-350',
        name: 'Ly Nhựa PET Trong Suốt 350ml',
        type: 'PACKAGING',
        quantity: 1,
        unit: 'pcs',
        unitCost: 580,
      },
      {
        itemId: 'BB-NAP-UONG-TRUC-TIEP',
        name: 'Nắp Uống Trực Tiếp Sipper Cap Phi 93',
        type: 'PACKAGING',
        quantity: 1,
        unit: 'pcs',
        unitCost: 300,
      },
    ],
  },

  // 4. Trà Hoa Cúc Mật Ong Rừng
  {
    id: 'RECIPE-TRA-CUC-MAT-ONG',
    sku: 'DRK-TCMO-500',
    name: 'Trà Hoa Cúc Mật Ong Rừng Thanh Nhiệt (500ml)',
    category: 'Trà Thảo Mộc',
    type: 'FINISHED_PRODUCT',
    yieldQuantity: 1,
    unit: 'pcs',
    sellingPrice: 42000,
    components: [
      {
        itemId: 'NL-HOA-CUC-KHO',
        name: 'Hoa Cúc Tiến Vua Sấy Lạnh',
        type: 'RAW_MATERIAL',
        quantity: 12,
        unit: 'g',
        wastePercent: 2,
        unitCost: 360,
      },
      {
        itemId: 'NL-MAT-ONG-RUNG',
        name: 'Mật Ong Rừng Tây Bắc Hoa Nhãn',
        type: 'RAW_MATERIAL',
        quantity: 25,
        unit: 'ml',
        wastePercent: 1,
        unitCost: 420,
      },
      {
        itemId: 'NL-CHANH-VANG',
        name: 'Chanh Vàng Eureka Cắt Lát',
        type: 'RAW_MATERIAL',
        quantity: 1,
        unit: 'pcs',
        unitCost: 1200,
      },
      {
        itemId: 'BB-LY-PP-500',
        name: 'Ly Nhựa PP 500ml Chống Nóng',
        type: 'PACKAGING',
        quantity: 1,
        unit: 'pcs',
        unitCost: 650,
      },
      {
        itemId: 'BB-NAP-KIM-CUONG',
        name: 'Nắp Cầu Kim Cương Phi 95',
        type: 'PACKAGING',
        quantity: 1,
        unit: 'pcs',
        unitCost: 250,
      },
      {
        itemId: 'BB-ONG-HUT-BOC-MANG',
        name: 'Ống Hút Nhọn Phi 8 Bọc Màng OPP',
        type: 'PACKAGING',
        quantity: 1,
        unit: 'pcs',
        unitCost: 150,
      },
    ],
  },

  // 5. Cà Phê Sữa Đá Sài Gòn
  {
    id: 'RECIPE-CF-SUA-DA',
    sku: 'DRK-CFSD-350',
    name: 'Cà Phê Sữa Đá Sài Gòn Đậm Vị (350ml)',
    category: 'Cà Phê Truyền Thống & Hiện Đại',
    type: 'FINISHED_PRODUCT',
    yieldQuantity: 1,
    unit: 'pcs',
    sellingPrice: 32000,
    components: [
      {
        itemId: 'NL-CA-PHE-ROBUSTA',
        name: 'Cà Phê Mộc Robusta Honey Đắk Lắk',
        type: 'RAW_MATERIAL',
        quantity: 25,
        unit: 'g',
        wastePercent: 2,
        unitCost: 220,
      },
      {
        itemId: 'NL-SUA-DAC',
        name: 'Sữa Đặc Ngôi Sao Phương Nam',
        type: 'RAW_MATERIAL',
        quantity: 35,
        unit: 'ml',
        wastePercent: 2,
        unitCost: 55,
      },
      {
        itemId: 'BB-LY-PET-350',
        name: 'Ly Nhựa PET Trong Suốt 350ml',
        type: 'PACKAGING',
        quantity: 1,
        unit: 'pcs',
        unitCost: 580,
      },
      {
        itemId: 'BB-NAP-KIM-CUONG',
        name: 'Nắp Cầu Kim Cương Phi 95',
        type: 'PACKAGING',
        quantity: 1,
        unit: 'pcs',
        unitCost: 250,
      },
      {
        itemId: 'BB-ONG-HUT-BOC-MANG',
        name: 'Ống Hút Nhọn Phi 8 Bọc Màng OPP',
        type: 'PACKAGING',
        quantity: 1,
        unit: 'pcs',
        unitCost: 150,
      },
    ],
  },

  // 6. Trà Ô Long Mãng Cầu Xiêm
  {
    id: 'RECIPE-TRA-OLONG-MANG-CAU',
    sku: 'DRK-TOLMC-500',
    name: 'Trà Ô Long Mãng Cầu Xiêm Tươi (500ml)',
    category: 'Trà Hoa Quả',
    type: 'FINISHED_PRODUCT',
    yieldQuantity: 1,
    unit: 'pcs',
    sellingPrice: 49000,
    components: [
      {
        itemId: 'NL-TRA-OLONG-XANH',
        name: 'Trà Ô Long Kim Tuyên Thơm Mùi Bơ',
        type: 'RAW_MATERIAL',
        quantity: 18,
        unit: 'g',
        wastePercent: 3,
        unitCost: 320,
      },
      {
        itemId: 'NL-MANG-CAU-TUOI',
        name: 'Mãng Cầu Xiêm Đắk Lắk Dầm Đường',
        type: 'RAW_MATERIAL',
        quantity: 65,
        unit: 'g',
        wastePercent: 5,
        unitCost: 140, // 140k/kg -> 140đ/g
      },
      {
        itemId: 'SUB-NUOC-DUONG',
        name: 'Nước Đường Tỷ Lệ Chuẩn 1:1',
        type: 'SEMI_FINISHED',
        quantity: 25,
        unit: 'ml',
        isSubRecipe: true,
        subRecipeId: 'SUB-NUOC-DUONG',
        unitCost: 22,
      },
      {
        itemId: 'BB-LY-PP-500',
        name: 'Ly Nhựa PP 500ml Chống Nóng',
        type: 'PACKAGING',
        quantity: 1,
        unit: 'pcs',
        unitCost: 650,
      },
      {
        itemId: 'BB-NAP-KIM-CUONG',
        name: 'Nắp Cầu Kim Cương Phi 95',
        type: 'PACKAGING',
        quantity: 1,
        unit: 'pcs',
        unitCost: 250,
      },
      {
        itemId: 'BB-ONG-HUT-TRAN-CHAU',
        name: 'Ống Hút Trân Châu Phi 12 Vát Nhọn',
        type: 'PACKAGING',
        quantity: 1,
        unit: 'pcs',
        unitCost: 180,
      },
    ],
  },

  // 7. Cà Phê Trứng Bếp Tổng Hà Nội
  {
    id: 'RECIPE-CF-TRUNG',
    sku: 'DRK-CFT-300',
    name: 'Cà Phê Trứng Nướng Bếp Tổng Hà Nội (300ml)',
    category: 'Cà Phê Truyền Thống & Hiện Đại',
    type: 'FINISHED_PRODUCT',
    yieldQuantity: 1,
    unit: 'pcs',
    sellingPrice: 45000,
    components: [
      {
        itemId: 'NL-CA-PHE-ROBUSTA',
        name: 'Cà Phê Mộc Robusta Honey Đắk Lắk',
        type: 'RAW_MATERIAL',
        quantity: 25,
        unit: 'g',
        wastePercent: 2,
        unitCost: 220,
      },
      {
        itemId: 'SUB-KEM-TRUNG',
        name: 'Kem Trứng Nướng Bếp Tổng',
        type: 'SEMI_FINISHED',
        quantity: 45,
        unit: 'ml',
        isSubRecipe: true,
        subRecipeId: 'SUB-KEM-TRUNG',
        unitCost: 96,
      },
      {
        itemId: 'NL-SUA-DAC',
        name: 'Sữa Đặc Ngôi Sao Phương Nam',
        type: 'RAW_MATERIAL',
        quantity: 15,
        unit: 'ml',
        wastePercent: 1,
        unitCost: 55,
      },
      {
        itemId: 'BB-LY-GIAY-300',
        name: 'Ly Giấy Kraft Cách Nhiệt 300ml',
        type: 'PACKAGING',
        quantity: 1,
        unit: 'pcs',
        unitCost: 750,
      },
      {
        itemId: 'BB-NAP-KIM-CUONG',
        name: 'Nắp Cầu Kim Cương Phi 95',
        type: 'PACKAGING',
        quantity: 1,
        unit: 'pcs',
        unitCost: 250,
      },
    ],
  },

  // 8. Trà Vải Hoa Hồng
  {
    id: 'RECIPE-TRA-VAI-HOA-HONG',
    sku: 'DRK-TVHH-500',
    name: 'Trà Vải Hoa Hồng Pháp Nữ Tính (500ml)',
    category: 'Trà Hoa Quả',
    type: 'FINISHED_PRODUCT',
    yieldQuantity: 1,
    unit: 'pcs',
    sellingPrice: 47000,
    components: [
      {
        itemId: 'NL-TRA-DEN-OPA',
        name: 'Trà Đen Ceylon OPA Thơm Đậm',
        type: 'RAW_MATERIAL',
        quantity: 15,
        unit: 'g',
        wastePercent: 3,
        unitCost: 260,
      },
      {
        itemId: 'NL-SIRO-VAI',
        name: 'Siro Vải Monin Lychee Syrup',
        type: 'RAW_MATERIAL',
        quantity: 35,
        unit: 'ml',
        wastePercent: 2,
        unitCost: 350,
      },
      {
        itemId: 'NL-VAI-NGAM',
        name: 'Trái Vải Ngâm Nước Đường Thái Lan',
        type: 'RAW_MATERIAL',
        quantity: 2,
        unit: 'pcs',
        unitCost: 2200,
      },
      {
        itemId: 'NL-COT-HOA-HONG',
        name: 'Nước Cốt Hoa Hồng Pháp Chưng Cất',
        type: 'RAW_MATERIAL',
        quantity: 5,
        unit: 'ml',
        unitCost: 400,
      },
      {
        itemId: 'BB-LY-PP-500',
        name: 'Ly Nhựa PP 500ml Chống Nóng',
        type: 'PACKAGING',
        quantity: 1,
        unit: 'pcs',
        unitCost: 650,
      },
      {
        itemId: 'BB-NAP-KIM-CUONG',
        name: 'Nắp Cầu Kim Cương Phi 95',
        type: 'PACKAGING',
        quantity: 1,
        unit: 'pcs',
        unitCost: 250,
      },
      {
        itemId: 'BB-ONG-HUT-BOC-MANG',
        name: 'Ống Hút Nhọn Phi 8 Bọc Màng OPP',
        type: 'PACKAGING',
        quantity: 1,
        unit: 'pcs',
        unitCost: 150,
      },
    ],
  },

  // 9. Matcha Latte Cốt Dừa Uji
  {
    id: 'RECIPE-MATCHA-LATTE-DUA',
    sku: 'DRK-MLD-500',
    name: 'Matcha Latte Cốt Dừa Uji Thượng Hạng (500ml)',
    category: 'Matcha & Trà Sữa',
    type: 'FINISHED_PRODUCT',
    yieldQuantity: 1,
    unit: 'pcs',
    sellingPrice: 52000,
    components: [
      {
        itemId: 'NL-BOT-MATCHA-UJI',
        name: 'Bột Matcha Uji Nhật Bản Hạng A',
        type: 'RAW_MATERIAL',
        quantity: 8,
        unit: 'g',
        wastePercent: 2,
        unitCost: 1200, // 1.2tr/kg -> 1200đ/g
      },
      {
        itemId: 'NL-COT-DUA-BENTRE',
        name: 'Nước Cốt Dừa Bến Tre Ép Tươi',
        type: 'RAW_MATERIAL',
        quantity: 40,
        unit: 'ml',
        wastePercent: 2,
        unitCost: 150,
      },
      {
        itemId: 'NL-SUA-TUOI-TT',
        name: 'Sữa Tươi Thanh Trùng Dalat Milk',
        type: 'RAW_MATERIAL',
        quantity: 120,
        unit: 'ml',
        wastePercent: 1,
        unitCost: 38,
      },
      {
        itemId: 'SUB-NUOC-DUONG',
        name: 'Nước Đường Tỷ Lệ Chuẩn 1:1',
        type: 'SEMI_FINISHED',
        quantity: 20,
        unit: 'ml',
        isSubRecipe: true,
        subRecipeId: 'SUB-NUOC-DUONG',
        unitCost: 22,
      },
      {
        itemId: 'BB-LY-PP-500',
        name: 'Ly Nhựa PP 500ml Chống Nóng',
        type: 'PACKAGING',
        quantity: 1,
        unit: 'pcs',
        unitCost: 650,
      },
      {
        itemId: 'BB-NAP-KIM-CUONG',
        name: 'Nắp Cầu Kim Cương Phi 95',
        type: 'PACKAGING',
        quantity: 1,
        unit: 'pcs',
        unitCost: 250,
      },
      {
        itemId: 'BB-ONG-HUT-BOC-MANG',
        name: 'Ống Hút Nhọn Phi 8 Bọc Màng OPP',
        type: 'PACKAGING',
        quantity: 1,
        unit: 'pcs',
        unitCost: 150,
      },
    ],
  },

  // 10. Trà Sữa Nướng Vân Nam
  {
    id: 'RECIPE-TS-NUONG-VAN-NAM',
    sku: 'DRK-TSNVN-500',
    name: 'Trà Sữa Nướng Đất Nung Vân Nam (500ml)',
    category: 'Trà Sữa',
    type: 'FINISHED_PRODUCT',
    yieldQuantity: 1,
    unit: 'pcs',
    sellingPrice: 49000,
    components: [
      {
        itemId: 'NL-TRA-NUONG-VN',
        name: 'Trà Đen Sao Nướng Vân Nam Hũ Đất',
        type: 'RAW_MATERIAL',
        quantity: 22,
        unit: 'g',
        wastePercent: 3,
        unitCost: 290,
      },
      {
        itemId: 'NL-BOT-SUA-BEO',
        name: 'Bột Sữa Béo Indo Kievit Vana Blanca',
        type: 'RAW_MATERIAL',
        quantity: 40,
        unit: 'g',
        wastePercent: 2,
        unitCost: 95,
      },
      {
        itemId: 'NL-DUONG-DEN',
        name: 'Đường Đen Hàn Quốc Beksul',
        type: 'RAW_MATERIAL',
        quantity: 15,
        unit: 'g',
        wastePercent: 1,
        unitCost: 60,
      },
      {
        itemId: 'SUB-TRAN-CHAU-HK',
        name: 'Trân Châu Hoàng Kim Nấu Sẵn',
        type: 'SEMI_FINISHED',
        quantity: 40,
        unit: 'g',
        isSubRecipe: true,
        subRecipeId: 'SUB-TRAN-CHAU-HK',
        unitCost: 32,
      },
      {
        itemId: 'BB-LY-PP-500',
        name: 'Ly Nhựa PP 500ml Chống Nóng',
        type: 'PACKAGING',
        quantity: 1,
        unit: 'pcs',
        unitCost: 650,
      },
      {
        itemId: 'BB-NAP-KIM-CUONG',
        name: 'Nắp Cầu Kim Cương Phi 95',
        type: 'PACKAGING',
        quantity: 1,
        unit: 'pcs',
        unitCost: 250,
      },
      {
        itemId: 'BB-ONG-HUT-TRAN-CHAU',
        name: 'Ống Hút Trân Châu Phi 12 Vát Nhọn',
        type: 'PACKAGING',
        quantity: 1,
        unit: 'pcs',
        unitCost: 180,
      },
    ],
  },
];
