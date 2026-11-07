import {
  StoreTransferOrder,
  ThermalReceiptK80Data,
  TransferItem,
  TransferItemSchema,
  TransferStatus,
} from './types';

export interface CreateTransferOrderParams {
  sourceBranchId?: string;
  sourceBranchName?: string;
  destBranchId: string;
  destBranchName: string;
  items: Array<Omit<TransferItem, 'barcode'> & { barcode?: string }>;
  notes?: string;
  createdBy?: string;
}

export interface DispatchTransferParams {
  order: StoreTransferOrder;
  driverName: string;
  vehiclePlate: string;
  sealNumber?: string;
  dispatchedBy: string;
}

export interface ReceiveTransferParams {
  order: StoreTransferOrder;
  scannedItems: Array<{
    itemId: string;
    receivedQty: number;
    notes?: string;
  }>;
  receivedBy: string;
  generalNotes?: string;
}

/**
 * Rút gọn mã chi nhánh cho mã phiếu STO
 */
function getBranchSlug(branchId: string): string {
  const map: Record<string, string> = {
    'CENTRAL-LONG-BIEN': 'LB',
    'BRANCH-HOAN-KIEM': 'HK',
    'BRANCH-CAU-GIAY': 'CG',
    'BRANCH-DONG-DA': 'DD',
    'BRANCH-HA-DONG': 'HD',
    'BRANCH-HAI-BA-TRUNG': 'HBT',
  };
  return map[branchId] || branchId.replace(/^BRANCH-/, '').substring(0, 3).toUpperCase();
}

/**
 * 1. Tạo Phiếu Điều Chuyển Kho Bếp Tổng (Store Transfer Order - STO)
 */
export function createTransferOrder(params: CreateTransferOrderParams): StoreTransferOrder {
  const {
    sourceBranchId = 'CENTRAL-LONG-BIEN',
    sourceBranchName = 'Bếp Tổng Trung Tâm Long Biên',
    destBranchId,
    destBranchName,
    items,
    notes,
    createdBy = 'Quản lý Kho Bếp Tổng',
  } = params;

  if (!items || items.length === 0) {
    throw new Error('Phiếu điều chuyển kho phải có ít nhất 1 mã nguyên vật liệu');
  }

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const randomSuffix = Math.floor(1000 + Math.random() * 9000);
  const srcSlug = getBranchSlug(sourceBranchId);
  const dstSlug = getBranchSlug(destBranchId);
  const orderCode = `STO-${srcSlug}-${dstSlug}-${dateStr}-${randomSuffix}`;
  const barcode = `*${orderCode}*`;

  const validatedItems: TransferItem[] = items.map((raw, idx) => {
    const itemBarcode = raw.barcode || `BAR-${raw.itemId}-${idx + 1}`;
    return TransferItemSchema.parse({
      ...raw,
      barcode: itemBarcode,
      dispatchedQty: raw.dispatchedQty ?? raw.requestedQty,
    });
  });

  const totalItems = validatedItems.length;
  const totalValue = validatedItems.reduce(
    (sum, i) => sum + i.dispatchedQty * (i.unitCost || 0),
    0
  );

  return {
    id: `ord_${Date.now()}_${randomSuffix}`,
    orderCode,
    barcode,
    sourceBranchId,
    sourceBranchName,
    destBranchId,
    destBranchName,
    status: 'DRAFT',
    createdAt: now.toISOString(),
    dispatchedBy: createdBy,
    items: validatedItems,
    totalItems,
    totalValue,
    notes,
    hasDiscrepancy: false,
  };
}

/**
 * 2. Điều xe & Xuất kho Bếp Tổng (Dispatch STO)
 */
export function dispatchTransfer(params: DispatchTransferParams): StoreTransferOrder {
  const { order, driverName, vehiclePlate, sealNumber, dispatchedBy } = params;

  if (order.status !== 'DRAFT' && order.status !== 'APPROVED') {
    throw new Error(
      `Không thể xuất kho phiếu có trạng thái '${order.status}'. Chỉ cho phép với DRAFT hoặc APPROVED.`
    );
  }

  const seal = sealNumber || `SEAL-LB-${Math.floor(100000 + Math.random() * 900000)}`;

  return {
    ...order,
    status: 'DISPATCHED',
    dispatchedAt: new Date().toISOString(),
    driverName,
    vehiclePlate,
    sealNumber: seal,
    dispatchedBy,
  };
}

/**
 * 3. Chi nhánh quét Barcode xác nhận nhập kho (Verify & Receive STO)
 * Đối soát số lượng thực nhận vs số lượng xuất kho từ Bếp Tổng
 */
export function verifyReceiveTransfer(params: ReceiveTransferParams): StoreTransferOrder {
  const { order, scannedItems, receivedBy, generalNotes } = params;

  if (order.status !== 'DISPATCHED' && order.status !== 'IN_TRANSIT') {
    throw new Error(
      `Không thể nhận hàng cho phiếu có trạng thái '${order.status}'. Chỉ nhận khi đang DISPATCHED hoặc IN_TRANSIT.`
    );
  }

  const scanMap = new Map(scannedItems.map((s) => [s.itemId, s]));
  let hasDiscrepancy = false;
  const discrepancyDetails: string[] = [];

  const updatedItems: TransferItem[] = order.items.map((item) => {
    const scan = scanMap.get(item.itemId);
    const receivedQty = scan ? scan.receivedQty : 0;

    if (receivedQty !== item.dispatchedQty) {
      hasDiscrepancy = true;
      const diff = receivedQty - item.dispatchedQty;
      const diffText = diff > 0 ? `thừa +${diff}` : `thiếu ${diff}`;
      discrepancyDetails.push(
        `${item.name} (${item.itemId}): Xuất ${item.dispatchedQty} ${item.unit}, Nhận ${receivedQty} ${item.unit} (${diffText})`
      );
    }

    return {
      ...item,
      receivedQty,
      notes: scan?.notes || item.notes,
    };
  });

  const status: TransferStatus = hasDiscrepancy ? 'DISCREPANCY' : 'RECEIVED';
  const discrepancyNotes = hasDiscrepancy
    ? `LỆCH KHI KIỂM NHẬN:\n- ${discrepancyDetails.join('\n- ')}`
    : undefined;

  return {
    ...order,
    status,
    receivedAt: new Date().toISOString(),
    receivedBy,
    items: updatedItems,
    hasDiscrepancy,
    discrepancyNotes,
    notes: generalNotes ? `${order.notes ? order.notes + ' | ' : ''}${generalNotes}` : order.notes,
  };
}

/**
 * 4. Tạo dữ liệu In Phiếu Điều Chuyển Khổ Nhiệt K80 (Thermal Printer 80mm)
 */
export function generateK80ReceiptData(
  order: StoreTransferOrder,
  branchAddresses?: Record<string, { address: string; phone: string }>
): ThermalReceiptK80Data {
  const defaultAddressBook: Record<string, { address: string; phone: string }> = {
    'CENTRAL-LONG-BIEN': {
      address: 'Lô C3 KCN Đài Tư, 386 Nguyễn Văn Linh, Long Biên, Hà Nội',
      phone: '024 3888 9999',
    },
    'BRANCH-HOAN-KIEM': {
      address: '42 Nhà Thờ, Hàng Trống, Hoàn Kiếm, Hà Nội',
      phone: '024 3928 6688',
    },
    'BRANCH-CAU-GIAY': {
      address: '185 Cầu Giấy, Dịch Vọng, Cầu Giấy, Hà Nội',
      phone: '024 3767 1122',
    },
    'BRANCH-DONG-DA': {
      address: '92 Đặng Văn Ngữ, Trung Tự, Đống Đa, Hà Nội',
      phone: '024 3574 3344',
    },
    'BRANCH-HA-DONG': {
      address: 'Tầng 1 AEON Mall Hà Đông, Dương Nội, Hà Đông, Hà Nội',
      phone: '024 3389 5566',
    },
    'BRANCH-HAI-BA-TRUNG': {
      address: '68 Phố Huế, Hàng Bài, Hai Bà Trưng, Hà Nội',
      phone: '024 3976 7788',
    },
    ...(branchAddresses || {}),
  };

  const srcInfo = defaultAddressBook[order.sourceBranchId] || {
    address: 'Tổng Kho & Bếp Trung Tâm Long Biên, Hà Nội',
    phone: '1900 6868',
  };

  const dstInfo = defaultAddressBook[order.destBranchId] || {
    address: order.destBranchName,
    phone: '090 123 4567',
  };

  const lines = order.items.map((item, idx) => ({
    stt: idx + 1,
    barcode: item.barcode,
    itemName: item.name,
    quantity: `${item.dispatchedQty} ${item.unit}`,
    unit: item.unit,
    lotExpiry: `Lô: ${item.lotNumber || 'L2610'} | HSD: ${item.expiryDate || '7 ngày'}`,
  }));

  const formatter = new Intl.NumberFormat('vi-VN', {
    style: 'currency',
    currency: 'VND',
  });

  return {
    title: 'PHIẾU XUẤT ĐIỀU CHUYỂN BẾP TỔNG',
    receiptNumber: order.orderCode,
    barcode: order.barcode,
    printedAt: new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
    source: {
      name: order.sourceBranchName,
      address: srcInfo.address,
      hotline: srcInfo.phone,
    },
    destination: {
      name: order.destBranchName,
      address: dstInfo.address,
      contact: dstInfo.phone,
    },
    transport: {
      driver: order.driverName || 'Chưa điều xe',
      vehiclePlate: order.vehiclePlate || 'Xe Tải Bếp Tổng',
      sealNumber: order.sealNumber || '---',
      dispatchTime: order.dispatchedAt
        ? new Date(order.dispatchedAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })
        : 'Chờ xuất bến',
    },
    lines,
    totalPackages: order.totalItems,
    totalValueFormatted: formatter.format(order.totalValue),
    notes: order.notes || 'Hàng lạnh giữ ở nhiệt độ 2°C - 5°C trong suốt quá trình vận chuyển.',
    signatures: {
      dispatcher: order.dispatchedBy || 'Thủ kho Bếp Tổng',
      transporter: order.driverName || 'Tài xế vận chuyển',
      receiver: order.receivedBy || 'Barista / Quản lý Nhận',
    },
  };
}
