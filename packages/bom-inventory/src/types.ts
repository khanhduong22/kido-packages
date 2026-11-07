import { z } from 'zod';

// ============================================================================
// 1. Material & Unit Definitions
// ============================================================================

export const ItemTypeSchema = z.enum([
  'RAW_MATERIAL',      // Nguyên liệu thô (Trà khô, Siro, Sữa đặc, Cà phê hạt...)
  'SEMI_FINISHED',     // Bán thành phẩm bếp tổng (Nước cốt trà, Kem trứng, Trân châu nấu...)
  'FINISHED_PRODUCT',  // Thành phẩm bán cho khách (Ly trà đào, Ly cà phê muối...)
  'PACKAGING',         // Bao bì đóng gói (Ly nhựa 500ml, Nắp, Ống hút, Túi chữ T...)
]);

export type ItemType = z.infer<typeof ItemTypeSchema>;

export const MeasurementUnitSchema = z.enum([
  'g',
  'kg',
  'ml',
  'l',
  'pcs',      // Cái, chiếc, ly, nắp, ống hút
  'portion',  // Phần, shot
]);

export type MeasurementUnit = z.infer<typeof MeasurementUnitSchema>;

// Unit conversion helper
export function convertUnit(
  value: number,
  fromUnit: MeasurementUnit,
  toUnit: MeasurementUnit
): number {
  if (fromUnit === toUnit) return value;

  // Weight conversions
  if (fromUnit === 'kg' && toUnit === 'g') return value * 1000;
  if (fromUnit === 'g' && toUnit === 'kg') return value / 1000;

  // Volume conversions
  if (fromUnit === 'l' && toUnit === 'ml') return value * 1000;
  if (fromUnit === 'ml' && toUnit === 'l') return value / 1000;

  // If incompatible, throw error
  throw new Error(`Cannot convert between incompatible units: ${fromUnit} and ${toUnit}`);
}

export function areUnitsCompatible(u1: MeasurementUnit, u2: MeasurementUnit): boolean {
  if (u1 === u2) return true;
  const isWeight = (u: MeasurementUnit) => u === 'g' || u === 'kg';
  const isVolume = (u: MeasurementUnit) => u === 'ml' || u === 'l';
  return (isWeight(u1) && isWeight(u2)) || (isVolume(u1) && isVolume(u2));
}

// ============================================================================
// 2. Bill of Materials (BOM) Schemas
// ============================================================================

export interface BOMComponent {
  itemId: string;
  name: string;
  type: ItemType;
  quantity: number;
  unit: MeasurementUnit;
  wastePercent?: number;
  unitCost?: number;
  isSubRecipe?: boolean;
  subRecipeId?: string;
  notes?: string;
}

export const BOMComponentSchema: z.ZodType<BOMComponent> = z.object({
  itemId: z.string().min(1, 'Mã nguyên liệu là bắt buộc'),
  name: z.string().min(1, 'Tên nguyên liệu là bắt buộc'),
  type: ItemTypeSchema,
  quantity: z.number().positive('Định lượng phải lớn hơn 0'),
  unit: MeasurementUnitSchema,
  wastePercent: z.number().min(0).max(100).optional().default(0),
  unitCost: z.number().min(0).optional().default(0),
  isSubRecipe: z.boolean().optional().default(false),
  subRecipeId: z.string().optional(),
  notes: z.string().optional(),
});

export const RecipeSchema = z.object({
  id: z.string().min(1),
  sku: z.string().min(1),
  name: z.string().min(1),
  category: z.string().min(1),
  type: z.enum(['FINISHED_PRODUCT', 'SEMI_FINISHED']),
  yieldQuantity: z.number().positive().default(1),    // Sản lượng tạo ra (ví dụ 1 ly hoặc 1000ml)
  unit: MeasurementUnitSchema.default('pcs'),
  costPrice: z.number().min(0).default(0),            // Giá vốn ước tính
  sellingPrice: z.number().min(0).optional(),         // Giá bán lẻ tại quầy
  shelfLifeHours: z.number().positive().optional(),    // Hạn bảo quản (giờ)
  components: z.array(BOMComponentSchema).min(1, 'Công thức phải có ít nhất 1 thành phần định lượng'),
  instructions: z.array(z.string()).optional(),
});

export type Recipe = {
  id: string;
  sku: string;
  name: string;
  category: string;
  type: 'FINISHED_PRODUCT' | 'SEMI_FINISHED';
  yieldQuantity?: number;
  unit?: MeasurementUnit;
  costPrice?: number;
  sellingPrice?: number;
  shelfLifeHours?: number;
  components: BOMComponent[];
  instructions?: string[];
};

// Exploded Material Result Item
export interface ExplodedMaterialItem {
  itemId: string;
  name: string;
  type: ItemType;
  totalQuantity: number;
  unit: MeasurementUnit;
  unitCost: number;
  totalCost: number;
  wasteQuantity: number;
  sourceLevel: number;
  parentRecipeNames: string[];
}

// Tree node representation for BOM hierarchy inspection
export interface BOMExplosionNode {
  recipeId: string;
  recipeName: string;
  quantity: number;
  unit: MeasurementUnit;
  level: number;
  components: Array<{
    component: BOMComponent;
    requiredQuantity: number;
    unit: MeasurementUnit;
    subTree?: BOMExplosionNode;
  }>;
}

export interface ExplosionResult {
  recipeId: string;
  recipeName: string;
  quantity: number;
  rawMaterials: ExplodedMaterialItem[];
  packaging: ExplodedMaterialItem[];
  semiFinished: ExplodedMaterialItem[];
  allMaterials: ExplodedMaterialItem[];
  totalCost: number;
  hierarchyTree: BOMExplosionNode;
}

// ============================================================================
// 3. Variance Analysis Schemas
// ============================================================================

export const VarianceSeveritySchema = z.enum([
  'NORMAL',                // Trong ngưỡng cho phép (< 2%)
  'WARNING',               // Sai lệch nhẹ (2% - 5%)
  'CRITICAL',              // Thất thoát đáng kể (5% - 10%)
  'INVESTIGATION_REQUIRED' // Thất thoát nghiêm trọng (> 10% hoặc giá trị lớn)
]);

export type VarianceSeverity = z.infer<typeof VarianceSeveritySchema>;

export const VarianceReasonSchema = z.enum([
  'NORMAL_TOLERANCE',      // Hao hụt định mức cho phép
  'OVER_PORTIONING',       // Nhân viên pha chế múc đong quá tay (over-portioning)
  'UNRECORDED_SPILLAGE',   // Làm đổ, rơi vỡ, hỏng mẻ nấu nhưng không ghi sổ hủy
  'POS_RINGING_ERROR',     // Thu ngân bấm sai bill / hủy bill ngoài hệ thống
  'THEFT_OR_LEAKAGE',      // Nghi vấn thất thoát hàng hóa, tuồn hàng ra ngoài
  'EXPIRY_SPOILAGE',       // Hàng hết hạn dùng phải loại bỏ
]);

export type VarianceReason = z.infer<typeof VarianceReasonSchema>;

export interface InventoryRecord {
  itemId: string;
  name: string;
  unit: MeasurementUnit;
  unitCost: number;
  openingStock: number;       // Tồn đầu kỳ
  transfersIn: number;        // Nhập điều chuyển từ bếp tổng
  transfersOut: number;       // Xuất trả / điều chuyển đi
  theoreticalUsage: number;   // Tiêu hao lý thuyết (BOM * số ly bán)
  actualCount: number;        // Tồn thực tế kiểm kê cuối kỳ
  recordedWaste?: number;     // Hao hụt đã có biên bản hủy
}

export interface ItemVarianceResult {
  itemId: string;
  name: string;
  unit: MeasurementUnit;
  unitCost: number;
  openingStock: number;
  transfersIn: number;
  transfersOut: number;
  theoreticalUsage: number;
  theoreticalClosing: number;  // Tồn lý thuyết = Đầu kỳ + Nhập - Tiêu hao - Xuất
  actualCount: number;         // Tồn thực tế kiểm kê
  actualUsage: number;         // Tiêu hao thực tế = Đầu kỳ + Nhập - Xuất - Tồn thực tế
  varianceQty: number;         // Sai lệch số lượng (actualCount - theoreticalClosing)
  variancePercent: number;     // Tỷ lệ % sai lệch so với tiêu hao lý thuyết
  varianceCost: number;        // Giá trị tài chính thất thoát / dư thừa (VND)
  severity: VarianceSeverity;  // Mức độ nghiêm trọng
  suggestedReason: VarianceReason;
  notes: string;
}

export interface StoreVarianceSummary {
  branchId: string;
  branchName: string;
  auditDate: string;
  period: { from: string; to: string };
  items: ItemVarianceResult[];
  totalVarianceCost: number;     // Tổng giá trị sai lệch (VND, số âm là thất thoát)
  highRiskItemsCount: number;    // Số nguyên liệu bị cảnh báo CRITICAL/INVESTIGATION
  leakageAlert: boolean;         // Cờ cảnh báo rò rỉ nguyên vật liệu
  overallHealthScore: number;    // Điểm tin cậy tồn kho (0-100)
}

// ============================================================================
// 4. Store Transfer Order (STO) Schemas
// ============================================================================

export const TransferStatusSchema = z.enum([
  'DRAFT',         // Mới tạo phiếu
  'APPROVED',      // Quản lý bếp duyệt
  'DISPATCHED',    // Bếp tổng xuất kho & Điều xe
  'IN_TRANSIT',    // Đang trên đường vận chuyển
  'RECEIVED',      // Chi nhánh quét barcode nhận đủ
  'DISCREPANCY',   // Có sai lệch số lượng khi nhận hàng
  'CANCELLED',     // Hủy phiếu
]);

export type TransferStatus = z.infer<typeof TransferStatusSchema>;

export interface TransferItem {
  itemId: string;
  name: string;
  category?: string;
  requestedQty: number;
  dispatchedQty: number;
  receivedQty?: number;
  unit: MeasurementUnit;
  unitCost?: number;
  lotNumber?: string;
  expiryDate?: string;
  barcode: string;
  notes?: string;
}

export const TransferItemSchema: z.ZodType<TransferItem> = z.object({
  itemId: z.string().min(1),
  name: z.string().min(1),
  category: z.string().optional().default('Nguyên liệu'),
  requestedQty: z.number().positive(),
  dispatchedQty: z.number().min(0),
  receivedQty: z.number().min(0).optional(),
  unit: MeasurementUnitSchema,
  unitCost: z.number().min(0).optional().default(0),
  lotNumber: z.string().optional(),
  expiryDate: z.string().optional(),
  barcode: z.string().min(1),
  notes: z.string().optional(),
});

export interface StoreTransferOrder {
  id: string;
  orderCode: string;          // Ví dụ: STO-LB-HK-20261001-001
  barcode: string;            // Mã barcode quét nhanh
  sourceBranchId: string;     // CENTRAL-LONG-BIEN
  sourceBranchName: string;   // Bếp Tổng Long Biên
  destBranchId: string;       // HK, CG, DD, HD, HBT
  destBranchName: string;     // Tên chi nhánh nhận
  status: TransferStatus;
  createdAt: string;
  dispatchedAt?: string;
  receivedAt?: string;
  driverName?: string;
  vehiclePlate?: string;
  sealNumber?: string;        // Số niêm chì thùng lạnh
  dispatchedBy?: string;      // Thủ kho bếp tổng
  receivedBy?: string;        // Quản lý / Barista chi nhánh
  items: TransferItem[];
  totalItems: number;
  totalValue: number;
  notes?: string;
  hasDiscrepancy: boolean;
  discrepancyNotes?: string;
}

export interface ThermalReceiptK80Data {
  title: string;
  receiptNumber: string;
  barcode: string;
  printedAt: string;
  source: {
    name: string;
    address: string;
    hotline: string;
  };
  destination: {
    name: string;
    address: string;
    contact: string;
  };
  transport: {
    driver: string;
    vehiclePlate: string;
    sealNumber: string;
    dispatchTime: string;
  };
  lines: Array<{
    stt: number;
    barcode: string;
    itemName: string;
    quantity: string;
    unit: string;
    lotExpiry: string;
  }>;
  totalPackages: number;
  totalValueFormatted: string;
  notes: string;
  signatures: {
    dispatcher: string;
    transporter: string;
    receiver: string;
  };
}
